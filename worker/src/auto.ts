// auto.ts — pick the keys a repository needs from what its caller may read. Rules first, then Clef
// (a System One model on Workers AI) for keys the rules don't settle. The input is the repo's file
// and dependency names only, never contents; the output can only name keys the caller can already
// read, so a wrong guess costs a missing or extra key, never access.

// The slice of the Workers AI System One call this uses, so tests can pass a fake.
export interface S1Client {
  systemOne(req: { state: unknown; questions: Record<string, unknown> }): PromiseLike<{ answers: Record<string, any> }>;
}

export function s1Client(ai: Ai | undefined, model = "clef"): S1Client | null {
  if (!ai) return null;
  return { systemOne: ({ state, questions }) => ai.run(`@cf/cloudflare/${model}` as any, { model, state, questions } as any) as any };
}

export const MAX_SIGNALS = 400, MAX_SIGNAL_LEN = 120;
export const MAX_ASKED = 40;       // candidate keys put to Clef in one call
export const NEED_ABOVE = 0.7;     // Clef must be fairly sure before a key is added
export const DEADLINE_MS = 5000;

// Signals look like "file:wrangler.jsonc" or "dep:@aws-sdk/client-s3" (see cli/tumbler gatherSignals).
interface Rule { when: RegExp; keys: RegExp; label: string }
const RULES: Rule[] = [
  { when: /^(file:(?:.*\/)?wrangler\.(jsonc?|toml)|dep:wrangler|dep:alchemy)$/, keys: /^(CLOUDFLARE_|CF_)/, label: "Cloudflare / wrangler" },
  { when: /^(dep:@aws-sdk\/.*|dep:aws-sdk|dep:boto3|dep:botocore|dep:aws-cdk-lib|file:(?:.*\/)?serverless\.ya?ml|file:(?:.*\/)?samconfig\.toml|file:(?:.*\/)?cdk\.json)$/, keys: /^AWS_/, label: "AWS SDK or tooling" },
  { when: /^(dep:openai|dep:@openrouter\/.*|dep:openrouter)$/, keys: /^(OPENAI_|OPENROUTER_)/, label: "OpenAI-compatible SDK" },
  { when: /^(dep:@anthropic-ai\/.*|dep:anthropic)$/, keys: /^ANTHROPIC_/, label: "Anthropic SDK" },
  { when: /^dep:posthog.*$/, keys: /^POSTHOG_/, label: "PostHog SDK" },
  { when: /^dep:(@pythnetwork\/.*|pyth.*)$/, keys: /^PYTH_/, label: "Pyth SDK" },
  { when: /^dep:@typesafe-ai\/.*$/, keys: /^TYPESAFE_/, label: "TypeSafe SDK" },
  { when: /^(dep:stripe|dep:@stripe\/.*)$/, keys: /^STRIPE_/, label: "Stripe SDK" },
  { when: /^(file:\.github\/workflows\/.*|dep:@octokit\/.*|dep:pygithub)$/, keys: /^(GITHUB_PAT|GH_)/, label: "GitHub API" },
  { when: /^(dep:tailscale|file:(?:.*\/)?tailscale.*)$/, keys: /^TS_/, label: "Tailscale" },
];

export interface Pick { name: string; why: string }

export function cleanSignals(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const s of raw) {
    if (typeof s !== "string" || !/^(file|dep):/.test(s) || s.length > MAX_SIGNAL_LEN) continue;
    out.add(s.toLowerCase());
    if (out.size >= MAX_SIGNALS) break;
  }
  return [...out];
}

export function byRules(signals: string[], keys: { name: string }[]): Pick[] {
  const picks: Pick[] = [];
  for (const k of keys) {
    const rule = RULES.find((r) => r.keys.test(k.name) && signals.some((s) => r.when.test(s)));
    if (rule) picks.push({ name: k.name, why: `rule: ${rule.label}` });
  }
  return picks;
}

const prob = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);

// One yes/no question per remaining key. Any error or timeout adds nothing (fail closed on access).
export async function byClef(client: S1Client | null, signals: string[], keys: { name: string; description: string }[],
  deadlineMs = DEADLINE_MS): Promise<Pick[]> {
  if (!client || !keys.length || !signals.length) return [];
  const asked = keys.slice(0, MAX_ASKED), questions: Record<string, unknown> = {};
  asked.forEach((k, i) => {
    questions[`k${i}`] = {
      type: "noul",
      instructions: `The state lists a code repository's file names and dependencies. Will code or tooling in this repository need the environment variable ${k.name} (${k.description || "no description"}) to run, test or deploy?`,
      criteria: {
        true: "The repository uses the service, SDK or CLI this credential is for.",
        false: "Nothing in the repository points at that service; the credential would go unused.",
      },
    };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("s1 deadline")), deadlineMs); });
    const { answers } = await Promise.race([client.systemOne({ state: { signals }, questions }), late]);
    return asked.flatMap((k, i) => {
      const a = answers?.[`k${i}`], p = a?.type === "noul" ? prob(a.noul) : null;
      return p !== null && p >= NEED_ABOVE ? [{ name: k.name, why: `clef ${p.toFixed(2)}` }] : [];
    });
  } catch {
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function autoKeys(client: S1Client | null, signals: string[], keys: { name: string; description: string }[]): Promise<Pick[]> {
  const ruled = byRules(signals, keys), done = new Set(ruled.map((p) => p.name));
  return [...ruled, ...(await byClef(client, signals, keys.filter((k) => !done.has(k.name))))];
}
