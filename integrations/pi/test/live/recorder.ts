import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export default function recorder(pi: any) {
  const clean = (value: any): any => Array.isArray(value) ? value.filter(item => item?.type !== 'thinking').map(clean) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !['thinking','thinkingSignature'].includes(key)).map(([key,item]) => [key,clean(item)])) : value;
  const log = (entry: any) => appendFileSync(process.env.BRAID_LIVE_LOG!, JSON.stringify(clean({ at: new Date().toISOString(), ...entry })) + '\n');
  let wrapped = false;
  const seenMerge = new Set<string>();
  pi.on('session_start', (_event: any, ctx: any) => {
    log({ kind: 'environment', cwd: ctx.cwd, model: ctx.model && `${ctx.model.provider}/${ctx.model.id}`,
      registryComplete: typeof ctx.modelRegistry?.complete, registryStream: typeof ctx.modelRegistry?.stream });
    if (wrapped || !ctx.modelRegistry?.complete) return;
    wrapped = true;
    const actual = ctx.modelRegistry.complete.bind(ctx.modelRegistry);
    const actualStream = ctx.modelRegistry.stream?.bind(ctx.modelRegistry);
    const logResponse = (nodeId: string, response: any) => log({ kind: 'node_response', nodeId, stopReason: response.stopReason, content: response.content, usage: response.usage,
      model: `${response.provider}/${response.responseModel ?? response.model}`, errorMessage: response.errorMessage });
    // Workers stream when the registry supports it; both paths share logging and injected failures.
    if (actualStream) ctx.modelRegistry.stream = (model: any, context: any, options: any) => {
      // Other requests keep Pi's own stream object.
      if (!workerNodeId(context)) return actualStream(model, context, options);
      let inner: any;
      const ready = before(model, context, options).then(nodeId => { inner = actualStream(model, context, options); return nodeId; });
      ready.catch(() => {});
      return {
        async *[Symbol.asyncIterator]() { await ready; yield* inner; },
        async result() {
          const nodeId = await ready;
          const response = await inner.result();
          if (nodeId) logResponse(nodeId, response);
          return response;
        },
      };
    };
    ctx.modelRegistry.complete = async (model: any, context: any, options: any) => {
      const nodeId = await before(model, context, options);
      const response = await actual(model, context, options);
      if (nodeId) logResponse(nodeId, response);
      return response;
    };
    /** Logs a worker request and applies this case's injections; undefined for non-worker requests. */
    function workerNodeId(context: any): string | undefined {
      try { return JSON.parse(context.messages[0]?.content)?.nodeId; } catch { return undefined; }
    }
    async function before(model: any, context: any, options: any): Promise<string | undefined> {
      const nodeId = workerNodeId(context);
      if (!nodeId) return undefined;
      const payload = JSON.parse(context.messages[0].content);
      log({ kind: 'node_request', nodeId, model: `${model.provider}/${model.id}`, systemPrompt: context.systemPrompt,
        payload, tools: context.tools, messages: context.messages });
      if (payload.mergeSources && !seenMerge.has(nodeId)) {
        seenMerge.add(nodeId);
        const files: Record<string, string | null> = {};
        for (const file of ['calculator.cjs', 'README.md', 'user.txt', 'partial.txt', 'review.txt']) {
          try { files[file] = readFileSync(join(payload.workspace.sourceRoot, file), 'utf8'); } catch { files[file] = null; }
        }
        log({ kind: 'source_before_merge_agent', nodeId, files });
      }
      if (process.env.BRAID_LIVE_CASE === 'partial-failure' && nodeId === 'fragile' &&
          context.messages.some((message: any) => message.role === 'toolResult' && message.toolName === 'write' && !message.isError)) {
        log({ kind: 'injected_failure', nodeId, message: 'Simulated provider failure after the real model successfully wrote its file' });
        throw new Error('LIVE_TEST_INJECTED_PROVIDER_FAILURE_AFTER_WRITE');
      }
      const successfulTools = context.messages.filter((message: any) => message.role === 'toolResult' && !message.isError);
      if (process.env.BRAID_LIVE_CASE === 'merge-failure' && nodeId === 'broken_merge' && successfulTools.length) {
        log({ kind: 'injected_failure', nodeId, message: 'Simulated merge provider failure after real model inspection' });
        throw new Error('LIVE_TEST_INJECTED_MERGE_PROVIDER_FAILURE');
      }
      if (process.env.BRAID_LIVE_CASE === 'cancel' && nodeId === 'worker' && successfulTools.some((message: any) => message.toolName === 'write')) {
        log({ kind: 'injected_pause', nodeId, message: 'Real write completed; notifying parent to cancel the running job' });
        pi.sendMessage({ customType: 'live-test-ready', content: 'Live test ready: worker successfully wrote cancelled.txt and is paused. Call braid_cancel with the submitted jobId now, then await completion and retrieve braid_status.', display: true }, { triggerTurn: true, deliverAs: 'followUp' });
        await new Promise((_, reject) => {
          const signal = options?.signal;
          if (!signal) { reject(new Error('LIVE_TEST_MISSING_ABORT_SIGNAL')); return; }
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return nodeId;
    }
  });
}
