import { renderOpeningComposite } from "./index.mjs";
import { captureOpeningComposite as captureTexturedOpening } from "./prismarine.mjs";

/** CPU is available explicitly; requested textures propagate capture errors. */
export async function captureOpeningComposite(
  snapshot,
  { textured = true, ...options } = {},
) {
  return textured
    ? captureTexturedOpening(snapshot, options)
    : renderOpeningComposite(snapshot, options);
}
export { renderOpeningComposite };
