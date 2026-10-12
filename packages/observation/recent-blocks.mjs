/**
 * Interval aggregation only. The caller supplies already-selected block samples;
 * this module does not decide reach, line of sight, air/fluid or interaction rules.
 * Reads never consume evidence. A caller may retire only a previously displayed
 * sample prefix after Inbox delivery, retaining samples since it.
 */
export function createRecentBlockAccumulator({ positionLimit = 3 } = {}) {
  if (!Number.isSafeInteger(positionLimit) || positionLimit < 0)
    throw new RangeError("positionLimit must be a nonnegative integer");
  let sequence = 0;
  const frames = new Map();
  const types = new Map();
  const faces = new Map();
  const timestamp = (value) => (Number.isFinite(value) ? value : null);
  const positionKey = ({ x, y, z }) => `${x},${y},${z}`;
  const cellCount = (value) => {
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError("Cell counts must be nonnegative integers or null");
    return value;
  };
  return {
    record({
      observedAt,
      sourceSampledAt = null,
      dimension = null,
      epoch = null,
      blocks = [],
      sampledCells = null,
      unknownCells = null,
      airCells = null,
      truncated = false,
      bounds = null,
      opaqueFaces = [],
    }) {
      if (!Number.isFinite(observedAt))
        throw new TypeError("observedAt must be a finite timestamp");
      if (dimension !== null && typeof dimension !== "string")
        throw new TypeError("dimension must be a string or null");
      if (epoch !== null && typeof epoch !== "string")
        throw new TypeError("epoch must be a string or null");
      sampledCells = cellCount(sampledCells);
      unknownCells = cellCount(unknownCells);
      airCells = cellCount(airCells);
      if (
        bounds !== null &&
        ![bounds.min, bounds.max].every(
          (p) => p && [p.x, p.y, p.z].every(Number.isSafeInteger),
        )
      )
        throw new TypeError("bounds must contain integer min/max coordinates");
      if (
        sampledCells !== null &&
        unknownCells !== null &&
        unknownCells > sampledCells
      )
        throw new RangeError("unknownCells cannot exceed sampledCells");
      // Validate and detach the whole sample before changing retained state.
      const selected = blocks.map(({ name, position }) => {
        if (typeof name !== "string" || name.length === 0)
          throw new TypeError("Each selected block needs an actual type name");
        if (
          !position ||
          ![position.x, position.y, position.z].every(Number.isSafeInteger)
        )
          throw new TypeError("Block positions must be integer coordinates");
        return {
          name: name.replace(/^minecraft:/, ""),
          position: { x: position.x, y: position.y, z: position.z },
        };
      });
      const selectedFaces = opaqueFaces.map(({ position, normal }) => {
        if (
          !position ||
          ![position.x, position.y, position.z].every(Number.isSafeInteger) ||
          !Array.isArray(normal) ||
          normal.length !== 3 ||
          !normal.every(Number.isInteger) ||
          normal.reduce((sum, value) => sum + Math.abs(value), 0) !== 1
        )
          throw new TypeError(
            "Opaque faces need integer coordinates and a unit axis normal",
          );
        return JSON.stringify([
          dimension,
          position.x,
          position.y,
          position.z,
          ...normal,
        ]);
      });
      const id = ++sequence;
      const frame = {
        observedAt,
        sourceSampledAt: timestamp(sourceSampledAt),
        dimension,
        epoch,
        sampledCells,
        unknownCells,
        airCells,
        truncated: truncated === true,
        bounds: bounds === null ? null : structuredClone(bounds),
      };
      frames.set(id, frame);
      for (const key of selectedFaces) faces.set(key, { dimension, id });
      for (const { name, position } of selected) {
        const key = JSON.stringify([dimension, name]);
        let type = types.get(key);
        if (!type) {
          type = { dimension, name, frames: new Set(), positions: new Map() };
          types.set(key, type);
        }
        // Multiple blocks of this type, or duplicate input rows, count once per sample.
        type.frames.add(id);
        type.positions.set(positionKey(position), { position, id });
      }
      return id;
    },
    snapshot() {
      const retained = [...frames.values()];
      const sumCells = (key) =>
        retained.some((frame) => frame[key] === null)
          ? null
          : retained.reduce((sum, frame) => sum + frame[key], 0);
      const sourceTimes = retained
        .map((frame) => frame.sourceSampledAt)
        .filter((value) => value !== null);
      const entries = [...types.values()]
        .map((type) => {
          const positions = [...type.positions.values()].sort(
            (a, b) =>
              b.id - a.id ||
              positionKey(a.position).localeCompare(positionKey(b.position)),
          );
          const latest = frames.get(positions[0].id);
          return {
            dimension: type.dimension,
            name: type.name,
            distinctPositions: positions.length,
            sampleFrames: type.frames.size,
            lastSampleAt: latest.observedAt,
            latestSourceSampledAt: latest.sourceSampledAt,
            latestPositions: positions
              .slice(0, positionLimit)
              .map(({ position, id }) => ({
                ...position,
                sampledAt: frames.get(id).observedAt,
              })),
            positionsOmitted: Math.max(0, positions.length - positionLimit),
          };
        })
        .sort(
          (a, b) =>
            String(a.dimension).localeCompare(String(b.dimension)) ||
            a.name.localeCompare(b.name),
        );
      const ranges = new Map();
      for (const frame of retained) {
        if (!frame.bounds) continue;
        let range = ranges.get(frame.dimension);
        if (!range) {
          range = structuredClone(frame.bounds);
          ranges.set(frame.dimension, range);
        } else
          for (const axis of ["x", "y", "z"]) {
            range.min[axis] = Math.min(range.min[axis], frame.bounds.min[axis]);
            range.max[axis] = Math.max(range.max[axis], frame.bounds.max[axis]);
          }
      }
      const surface = new Map();
      for (const face of faces.values())
        surface.set(face.dimension, (surface.get(face.dimension) ?? 0) + 1);
      return {
        throughSample: sequence,
        samples: retained.length,
        firstSampleAt: retained[0]?.observedAt ?? null,
        lastSampleAt: retained.at(-1)?.observedAt ?? null,
        maxSampleGapMs:
          retained.length < 2
            ? null
            : retained.reduce(
                (largest, frame, index) =>
                  index
                    ? Math.max(
                        largest,
                        frame.observedAt - retained[index - 1].observedAt,
                      )
                    : largest,
                0,
              ),
        sourceSampledAt: {
          oldest: sourceTimes.length
            ? sourceTimes.reduce((a, b) => Math.min(a, b))
            : null,
          latest: sourceTimes.length
            ? sourceTimes.reduce((a, b) => Math.max(a, b))
            : null,
          unknownSamples: retained.length - sourceTimes.length,
        },
        sourceEpochs: [...new Set(retained.map((frame) => frame.epoch))],
        dimensions: [...new Set(retained.map((frame) => frame.dimension))],
        sampledCellReads: sumCells("sampledCells"),
        unknownCellReads: sumCells("unknownCells"),
        airCellReads: sumCells("airCells"),
        truncatedSamples: retained.filter((frame) => frame.truncated).length,
        sampledRanges: [...ranges].map(([dimension, bounds]) => ({
          dimension,
          bounds,
        })),
        opaqueBoundaryArea: [...surface].map(([dimension, area]) => ({
          dimension,
          area,
        })),
        entries,
        coverage:
          "Sampled observations only, not continuous visual coverage or proof of reachability. distinctPositions counts coordinate values per dimension and type; a null dimension does not identify a world. sampleFrames counts samples containing the type, not block instances or elapsed time. Cell reads include repeat coordinates across samples.",
      };
    },
    retireThrough(throughSample) {
      if (
        !Number.isSafeInteger(throughSample) ||
        throughSample < 0 ||
        throughSample > sequence
      )
        throw new RangeError(
          "throughSample must name an existing sample prefix",
        );
      for (const id of frames.keys())
        if (id <= throughSample) frames.delete(id);
      for (const [key, face] of faces)
        if (face.id <= throughSample) faces.delete(key);
      for (const [key, type] of types) {
        for (const id of type.frames)
          if (id <= throughSample) type.frames.delete(id);
        for (const [position, last] of type.positions)
          if (last.id <= throughSample) type.positions.delete(position);
        if (!type.positions.size) types.delete(key);
      }
    },
  };
}
