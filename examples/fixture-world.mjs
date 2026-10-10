/** TEST FIXTURE ONLY. Synthetic blocks for deterministic renderer acceptance, not a real map. */
export function fixtureWorld() {
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 8, z: 15 } };
  const blocks = [];
  for (let z = 0; z <= 15; z++)
    for (let x = 0; x <= 15; x++)
      for (let y = 0; y <= 8; y++) {
        if (x >= 12 && z >= 12) continue; // Deliberately unknown corner.
        let name = y === 0 ? "grass_block" : "air";
        if (x >= 2 && x <= 5 && z >= 3 && z <= 6 && y <= 4)
          name = y === 4 ? "oak_planks" : "stone";
        if (x === 8 && z >= 2 && z <= 11 && y === 1) name = "red_wool";
        if (x >= 9 && x <= 12 && z >= 2 && z <= 5 && y === 0) name = "water";
        if (x === 3 && z === 4 && y === 5) name = "yellow_wool";
        blocks.push({ x, y, z, name });
      }
  return {
    bounds,
    blocks,
    version: "1.20.4",
    sampledAt: "2026-10-10T00:00:00Z",
    sequence: 1,
    source: "SYNTHETIC TEST FIXTURE, not real Minecraft world observations",
  };
}
