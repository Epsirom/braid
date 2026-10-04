import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Enforce the write boundary in filesystem operations, not in model instructions. */
export async function createWriteOperations(
  cwd: string, root: string, signal: AbortSignal,
  readOnlyPaths: () => Promise<string[]> = async () => [],
) {
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
  const writeFile = async (path: string, content: string): Promise<void> => {
    const target = await checked(path);
    // O_NOFOLLOW prevents following a replaced final symlink. Nodes have no
    // operations that create links or rename directories; workspaces are private.
    const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink > 1) throw new Error("Writing special files or hard links is not allowed");
      signal.throwIfAborted();
      await file.truncate(0);
      await file.writeFile(content, "utf8");
    } finally {
      await file.close();
    }
  };
  return {
    read: async (path: string) => readFile(await checked(resolve(cwd, path)), "utf8"),
    write: async (path: string, content: string) => {
      const target = await checked(resolve(cwd, path));
      await mkdir(await checked(resolve(target, "..")), { recursive: true });
      await writeFile(target, content);
    },
  };
}
