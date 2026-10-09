import { execFile, spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";
/** Own the entire process group through completion, cancellation, and timeout. */
export async function runCommand(shell: string, args: string[], cwd: string, signal: AbortSignal, timeout?: number,
  onOutput?: (output: string) => void): Promise<string> {
  let output = "";
  const onData = (data: Buffer) => {
    const text = data.toString();
    output = (output + text).slice(-50_000);
    try { onOutput?.(text); } catch { /* Observers cannot affect the command. */ }
  };
  signal?.throwIfAborted();
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647))
    throw new Error("Invalid timeout: expected positive seconds within the timer limit");

  const child = spawn(shell, args, {
    cwd, detached: process.platform !== "win32", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> => termination ??= (async () => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true }, error => {
            // taskkill reports 128 when the process has already exited.
            if (error && error.code !== 128) reject(error);
            else resolve();
          });
      });
    } else {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  })();
  // The completion path awaits termination; event handlers must not create
  // unhandled rejections while the shell is still exiting.
  const stop = () => { void terminate().catch(() => {}); };
  let timedOut = false;
  const timer = timeout === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    stop();
  }, timeout * 1000);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  let exitCode: number | null;
  try {
    exitCode = await exited;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    // Stop leftover children even on successful command completion. Commands
    // cannot leave a server/watch process writing during checkpoint/cleanup.
    try { await terminate(); }
    finally {
      // A daemon can leave the process group while holding inherited pipes.
      // Bound pipe draining; this process-group cleanup is not an OS sandbox.
      const drainTimer = setTimeout(() => {
        child.stdout!.destroy();
        child.stderr!.destroy();
      }, 250);
      try { await closed; }
      finally { clearTimeout(drainTimer); }
    }
  }
  if (signal?.aborted) throw new Error("aborted");
  if (timedOut) throw new Error(`timeout:${timeout}`);
  return JSON.stringify({ output, exitCode: exitCode ?? (child.signalCode ? 128 + (constants.signals[child.signalCode] ?? 0) : 1) });
}
