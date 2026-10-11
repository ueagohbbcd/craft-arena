// Search only loaded columns. Section bounds let synchronous queries stop once
// no unvisited section can improve the result, without reducing their radius.
export function findBlocksInColumns(
  bot,
  { matching, maxDistance, count, point },
) {
  const limit = count < 0 ? Infinity : Math.trunc(Number(count)) || 0;
  if (limit === 0 || maxDistance < 0) return [];
  const predicate = typeof matching === "function" ? matching : null;
  const types = predicate
    ? null
    : new Set(Array.isArray(matching) ? matching : [matching]);
  const sections = [];
  let columnOrder = 0;
  for (const [id, { chunk }] of bot.columns) {
    const order = columnOrder++;
    const [cx, cz] = id.split(",").map(Number);
    const minY = chunk.minY ?? bot.game?.minY ?? 0;
    const height = chunk.worldHeight ?? bot.game?.height ?? 256;
    const x0 = Math.max(cx * 16, Math.ceil(point.x - maxDistance));
    const x1 = Math.min(cx * 16 + 15, Math.floor(point.x + maxDistance));
    const z0 = Math.max(cz * 16, Math.ceil(point.z - maxDistance));
    const z1 = Math.min(cz * 16 + 15, Math.floor(point.z + maxDistance));
    const bottom = Math.max(minY, Math.ceil(point.y - maxDistance));
    const top = Math.min(minY + height - 1, Math.floor(point.y + maxDistance));
    if (x0 > x1 || z0 > z1 || bottom > top) continue;
    for (
      let sy = Math.floor((bottom - minY) / 16);
      sy <= Math.floor((top - minY) / 16);
      sy++
    ) {
      const y0 = Math.max(bottom, minY + sy * 16);
      const y1 = Math.min(top, minY + sy * 16 + 15);
      const distance = bot
        ._vector({
          x: Math.max(x0, Math.min(point.x, x1)),
          y: Math.max(y0, Math.min(point.y, y1)),
          z: Math.max(z0, Math.min(point.z, z1)),
        })
        .distanceTo(point);
      if (distance > maxDistance) continue;
      // A function may read position, light, entity data, or other real block
      // fields. Never call it on a palette's position-less placeholder block.
      if (types && !sectionMayMatch(chunk, sy, types, bot.registry)) continue;
      sections.push({ chunk, order, x0, x1, y0, y1, z0, z1, distance });
    }
  }
  sections.sort((a, b) => a.distance - b.distance);
  const nearest = [];
  const local = bot._vector({ x: 0, y: 0, z: 0 });
  const probe = bot._vector({ x: 0, y: 0, z: 0 });
  for (const section of sections) {
    // Strict comparison is essential: equal-distance blocks may have an
    // earlier original iterator rank than the current last result.
    if (nearest.length >= limit && section.distance > nearest.at(-1).distance)
      break;
    const { chunk, order, x0, x1, y0, y1, z0, z1 } = section;
    for (let x = x0; x <= x1; x++) {
      local.x = x & 15;
      probe.x = x;
      for (let z = z0; z <= z1; z++) {
        local.z = z & 15;
        probe.z = z;
        for (let y = y0; y <= y1; y++) {
          probe.y = y;
          const distance = probe.distanceTo(point);
          if (
            distance > maxDistance ||
            (nearest.length >= limit && distance > nearest.at(-1).distance)
          )
            continue;
          local.y = y;
          let position;
          if (predicate) {
            const block = chunk.getBlock(local);
            block.position = bot._vector({ x, y, z });
            if (!predicate(block)) continue;
            position = block.position;
          } else {
            const type =
              typeof chunk.getBlockType === "function"
                ? chunk.getBlockType(local)
                : chunk.getBlock(local).type;
            if (!types.has(type)) continue;
            position = bot._vector({ x, y, z });
          }
          const candidate = { position, distance, order, x, y, z };
          if (
            nearest.length >= limit &&
            compare(candidate, nearest.at(-1)) >= 0
          )
            continue;
          let low = 0,
            high = nearest.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (compare(nearest[middle], candidate) <= 0) low = middle + 1;
            else high = middle;
          }
          nearest.splice(low, 0, candidate);
          if (nearest.length > limit) nearest.pop();
        }
      }
    }
  }
  return nearest.slice(0, count).map(({ position }) => position);
}

function compare(a, b) {
  return (
    a.distance - b.distance ||
    a.order - b.order ||
    a.x - b.x ||
    a.z - b.z ||
    a.y - b.y
  );
}

function sectionMayMatch(chunk, sy, types, registry) {
  if (!Array.isArray(chunk.sections) || !registry?.blocksByStateId) return true;
  const section = chunk.sections[sy];
  const palette = section?.palette;
  // An absent section is known air; a single-value section has no palette.
  const states = !section
    ? [0]
    : Array.isArray(palette)
      ? palette
      : typeof section.data?.value === "number"
        ? [section.data.value]
        : null;
  // Global palettes and unfamiliar chunk representations require a scan.
  if (!states) return true;
  return states.some(
    (state) =>
      !registry.blocksByStateId[state] ||
      types.has(registry.blocksByStateId[state].id),
  );
}
