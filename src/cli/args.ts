/** Tiny flag parser: `--key value`, `--key=value`, `--flag`. */
export interface Args {
  string(name: string): string | undefined;
  number(name: string): number | undefined;
  list(name: string): string[] | undefined;
  bool(name: string): boolean;
}

export function parseArgs(argv: string[]): Args {
  const values = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token || !token.startsWith("--")) continue;
    const body = token.slice(2);

    if (body.includes("=")) {
      const idx = body.indexOf("=");
      values.set(body.slice(0, idx), body.slice(idx + 1));
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(body, next);
      i += 1;
    } else {
      values.set(body, true);
    }
  }

  return {
    string(name) {
      const value = values.get(name);
      return typeof value === "string" ? value : undefined;
    },
    number(name) {
      const value = values.get(name);
      if (typeof value !== "string") return undefined;
      const num = Number(value);
      return Number.isFinite(num) ? num : undefined;
    },
    list(name) {
      const value = values.get(name);
      if (typeof value !== "string") return undefined;
      return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    },
    bool(name) {
      return values.has(name);
    },
  };
}
