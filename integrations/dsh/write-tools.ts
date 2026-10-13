import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Enforce the write boundary in filesystem operations, not in model instructions. */
export async function createWriteBoundary(
  root: string, signal: AbortSignal,
  readOnlyPaths: () => Promise<string[]> = async () => [],
): Promise<(path: string) => Promise<string>> {
  const boundary = await realpath(root);
  const gitMetadata = await lstat(join(boundary, ".git"));
  const checked = async (path: string): Promise<string> => {
    signal.throwIfAborted();
    const target = resolve(path);
    // Callers can pass a lexical /tmp path while realpath uses /private/tmp on macOS.
    const outside = (path: string) => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
    let relativePath = relative(root, target);
    if (outside(relativePath)) relativePath = relative(boundary, target);
    if (outside(relativePath))
      throw new Error("Writes are allowed only inside this node's worktree");
    if ((await readOnlyPaths()).some(path => relativePath === path || relativePath.startsWith(`${path}${sep}`)))
      throw new Error("Writing inside submodules is not supported");
    const parts = relativePath.split(sep).filter(Boolean);
    if (parts.some(part => part.toLowerCase() === ".git"))
      throw new Error("Writing Git metadata is not allowed");
    let current = boundary;
    // Reject symlinks, including dangling links and linked parent directories.
    for (const part of parts) {
      current = join(current, part);
      try {
        const stat = await lstat(current);
        // Also catch filesystem-specific aliases of .git (case/Unicode/streams).
        if (stat.dev === gitMetadata.dev && stat.ino === gitMetadata.ino)
          throw new Error("Writing Git metadata is not allowed");
        if (stat.isSymbolicLink()) throw new Error("Writing through symlinks is not allowed");
        if (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1))
          throw new Error("Writing special files or hard links is not allowed");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    signal.throwIfAborted();
    return current;
  };
  return checked;
}
