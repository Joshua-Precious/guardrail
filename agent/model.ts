/**
 * Provider-neutral model layer.
 *
 * The agent loop only knows `ModelClient`. Any tool-calling model can be wired
 * in without touching tools, prompts, or the Cequre client:
 *
 *   AI_PROVIDER=scripted          (default) deterministic, no network, keyless
 *   AI_PROVIDER=openai-compatible OpenAI / OpenRouter / Groq / Together / Ollama / vLLM
 *   AI_PROVIDER=anthropic         Anthropic Messages API
 *
 * Config: AI_PROVIDER, AI_MODEL, AI_BASE_URL, AI_API_KEY.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
}

export interface ModelClient {
  readonly name: string;
  chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult>;
}

/** A pre-planned tool sequence used by the deterministic `scripted` provider. */
export interface ScriptedScenario {
  steps: Array<{ name: string; arguments: Record<string, any> }>;
  finalMessage: string;
}

export function createModelClient(scenario?: ScriptedScenario): ModelClient {
  const provider = (process.env.AI_PROVIDER ?? "scripted").toLowerCase();
  switch (provider) {
    case "anthropic":
      return new AnthropicClient();
    case "openai":
    case "openai-compatible":
    case "compatible":
      return new OpenAICompatibleClient();
    case "scripted":
    case "":
      if (!scenario) {
        throw new Error(
          "The scripted provider needs a scenario. Pass one, or set AI_PROVIDER to a real provider."
        );
      }
      return new ScriptedModelClient(scenario);
    default:
      throw new Error(`Unknown AI_PROVIDER "${provider}"`);
  }
}

// --- deterministic provider ----------------------------------------------

/** Emits a fixed tool sequence, then a final message. Used by tests and demos. */
export class ScriptedModelClient implements ModelClient {
  readonly name = "scripted";
  private step = 0;

  constructor(private readonly scenario: ScriptedScenario) {}

  async chat(): Promise<ChatResult> {
    if (this.step < this.scenario.steps.length) {
      const next = this.scenario.steps[this.step++];
      return {
        content: null,
        toolCalls: [{ id: `scripted-${this.step}`, name: next.name, arguments: next.arguments }],
      };
    }
    return { content: this.scenario.finalMessage, toolCalls: [] };
  }
}

// --- shared helpers -------------------------------------------------------

function requireConfig(): { baseUrl: string; apiKey: string; model: string } {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL?.replace(/\/+$/, "");
  const model = process.env.AI_MODEL;
  if (!apiKey) throw new Error("AI_API_KEY is required for this provider");
  if (!baseUrl) throw new Error("AI_BASE_URL is required for this provider");
  if (!model) throw new Error("AI_MODEL is required for this provider");
  return { baseUrl, apiKey, model };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  return data as any;
}

// --- OpenAI-compatible provider ------------------------------------------

/** Works with anything speaking the Chat Completions tool-calling API. */
export class OpenAICompatibleClient implements ModelClient {
  readonly name = "openai-compatible";

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
    const { baseUrl, apiKey, model } = requireConfig();

    const wireMessages = messages.map((message) => {
      if (message.role === "assistant") {
        return {
          role: "assistant",
          content: message.content ?? null,
          ...(message.toolCalls?.length
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : {}),
        };
      }
      if (message.role === "tool") {
        return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
      }
      return { role: message.role, content: message.content };
    });

    const data = await postJson(
      `${baseUrl}/chat/completions`,
      { Authorization: `Bearer ${apiKey}` },
      {
        model,
        messages: wireMessages,
        tools: tools.map((tool) => ({ type: "function", function: tool })),
      }
    );

    const choice = data.choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = (choice.tool_calls ?? []).map((call: any) => ({
      id: call.id,
      name: call.function?.name,
      arguments: safeParse(call.function?.arguments),
    }));

    return { content: choice.content ?? null, toolCalls };
  }
}

// --- Anthropic provider ---------------------------------------------------

export class AnthropicClient implements ModelClient {
  readonly name = "anthropic";

  async chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResult> {
    const { baseUrl, apiKey, model } = requireConfig();

    const system = messages
      .filter((message): message is { role: "system"; content: string } => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    const wireMessages: any[] = [];
    for (const message of messages) {
      if (message.role === "system") continue;
      if (message.role === "assistant") {
        const content: any[] = [];
        if (message.content) content.push({ type: "text", text: message.content });
        for (const call of message.toolCalls ?? []) {
          content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
        }
        wireMessages.push({ role: "assistant", content });
      } else if (message.role === "tool") {
        wireMessages.push({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: message.toolCallId, content: message.content },
          ],
        });
      } else {
        wireMessages.push({ role: "user", content: [{ type: "text", text: message.content }] });
      }
    }

    const data = await postJson(
      `${baseUrl}/v1/messages`,
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      {
        model,
        max_tokens: Number(process.env.AI_MAX_TOKENS ?? 1024),
        system,
        messages: wireMessages,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters,
        })),
      }
    );

    let content: string | null = null;
    const toolCalls: ToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text") content = (content ?? "") + block.text;
      if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
      }
    }
    return { content, toolCalls };
  }
}

function safeParse(value: unknown): Record<string, any> {
  if (value && typeof value === "object") return value as Record<string, any>;
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
