import type { PanelJob } from "../panel-types.js";

/** Longest-path ranks in the forward DAG. Feedback is drawn separately. */
export function layoutGraph(nodes: PanelJob["nodes"], edges: PanelJob["edges"]) {
  const rank = new Map(nodes.map(node => [node.id, 0]));
  const incoming = new Map(nodes.map(node => [node.id, 0]));
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (edge.feedback || !rank.has(edge.from) || !rank.has(edge.to)) continue;
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const queue = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  for (let i = 0; i < queue.length; i++) for (const to of outgoing.get(queue[i]!)!) {
    rank.set(to, Math.max(rank.get(to)!, rank.get(queue[i]!)! + 1));
    incoming.set(to, incoming.get(to)! - 1);
    if (incoming.get(to) === 0) queue.push(to);
  }
  const columns = new Map<number, number>();
  const positions = new Map(nodes.map(node => {
    const row = rank.get(node.id)!, column = columns.get(row) ?? 0;
    columns.set(row, column + 1);
    return [node.id, { x: 32 + column * 186, y: 28 + row * 124 }];
  }));
  return { positions, width: Math.max(280, ...[...columns.values()].map(count => count * 186 + 32)),
    height: Math.max(160, ...[...rank.values()].map(row => (row + 1) * 124 + 28)) };
}
