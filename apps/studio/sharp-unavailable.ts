// The packaged server cannot load sharp's native addon. Only gltf-transform's texture
// helpers reach it, and Studio never calls them, so a call here is a packaging bug.
export default function sharp(): never {
  throw new Error("Image processing with sharp is not available in the packaged Studio server.");
}
