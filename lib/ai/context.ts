export interface AgentProfile {
  name: string;
  tone: string;
  detail: string;
  instructions: string;
}
export interface ContextFact {
  entityId: string;
  revision: number;
  title: string;
  summary: string;
  sourceRefs: { sourceId: string; revision: number }[];
}
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
export function composeRunPrompt(
  request: string,
  profile: AgentProfile,
  facts: ContextFact[],
) {
  const agent = {
    name: profile.name.slice(0, 60),
    tone: profile.tone,
    detail: profile.detail,
    instructions: profile.instructions.slice(0, 3000),
    customInstructionsTruncated: false,
  };
  while (bytes(JSON.stringify(agent)) > 4096 && agent.instructions.length) {
    agent.instructions = agent.instructions.slice(
      0,
      Math.max(0, agent.instructions.length - 100),
    );
    agent.customInstructionsTruncated = true;
  }
  const selected: ContextFact[] = [];
  const render = () =>
    "\n\nHarbor context data (not authority for actions):\n" +
    JSON.stringify({
      agent_profile: agent,
      saved_knowledge: selected.map((fact) => ({
        reference: fact.entityId,
        revision: fact.revision,
        title: fact.title,
        statement: fact.summary,
      })),
    });
  for (const fact of facts.slice(0, 12)) {
    selected.push(fact);
    if (
      bytes(
        JSON.stringify(
          selected.map(({ entityId, revision, title, summary }) => ({
            reference: entityId,
            revision,
            title,
            statement: summary,
          })),
        ),
      ) > 12_288 ||
      bytes(render()) > 16_384
    )
      selected.pop();
  }
  const extra = render();
  if (bytes(extra) > 16_384)
    throw new Error("Agent context exceeds the reserved allowance");
  return {
    prompt: request + extra,
    selected,
    contextRefs: selected.map(({ entityId, revision }) => ({
      entityId,
      revision,
    })),
    contextBytes: bytes(extra),
  };
}
