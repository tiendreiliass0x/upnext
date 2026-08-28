/**
 * The file to put on the wire for a preview upload: the browser-trimmed clip
 * when that works, the original otherwise.
 *
 * The encoder is loaded on demand so DJs who never upload a file (library-only
 * sets) do not pay for it in the first load. That load can itself fail — on
 * patchy venue wifi, or after a redeploy has retired the chunk — and nothing
 * about trimming may ever fail an upload: the server re-encodes regardless, so
 * a browser that cannot trim loses bandwidth, never correctness.
 */
export async function prepareUploadFile(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<File> {
  try {
    const { trimToPreview } = await import("@/lib/preview-client");
    return (await trimToPreview(file, onProgress)) ?? file;
  } catch {
    return file;
  }
}
