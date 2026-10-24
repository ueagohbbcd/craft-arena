import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

/**
 * One of Pi's built-in chat models, named `provider/id` (the names in
 * https://pi.dev/models and `pi --list-models`). Throws for any other name.
 */
export function piBuiltinModel(name) {
  const match = /^([^/\s]+)\/(\S+)$/.exec(String(name ?? ""));
  const model = match && getBuiltinModel(match[1], match[2]);
  if (!model)
    throw new Error(
      `${JSON.stringify(name)} is not a Pi built-in model; write provider/id as Pi lists it (pi --list-models)`,
    );
  return model;
}
