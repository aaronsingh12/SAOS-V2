import "server-only";

import { randomUUID } from "node:crypto";
import { readFile, mkdir, rename, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ConnectionConfig = {
  instanceUrl: string;
  username: string;
  password: string;
  domainMode: "separated" | "global";
};
const root = process.env.SAOS_DATA_DIR
  ? dirname(process.env.SAOS_DATA_DIR)
  : join(process.cwd(), ".saos-data");
const configPath = join(root, "connection.json");

function validateUrl(raw: string) {
  const url = new URL(raw.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Enter the HTTPS instance address only, without a path or password",
    );
  return url.origin;
}

async function savedConfig(): Promise<ConnectionConfig | null> {
  try {
    const parsed = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as Partial<ConnectionConfig>;
    if (
      typeof parsed.instanceUrl !== "string" ||
      typeof parsed.username !== "string" ||
      typeof parsed.password !== "string" ||
      (parsed.domainMode !== "separated" && parsed.domainMode !== "global")
    ) {
      throw new Error(
        "Saved connection settings are invalid. Re-enter them in Settings.",
      );
    }
    return {
      instanceUrl: validateUrl(parsed.instanceUrl),
      username: parsed.username.trim(),
      password: parsed.password,
      domainMode: parsed.domainMode,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function getConnectionConfig(): Promise<ConnectionConfig | null> {
  const saved = await savedConfig();
  if (saved) return saved;
  if (
    !process.env.SERVICENOW_INSTANCE_URL ||
    !process.env.SERVICENOW_USERNAME ||
    !process.env.SERVICENOW_PASSWORD
  )
    return null;
  return {
    instanceUrl: process.env.SERVICENOW_INSTANCE_URL,
    username: process.env.SERVICENOW_USERNAME,
    password: process.env.SERVICENOW_PASSWORD,
    domainMode:
      process.env.SERVICENOW_DOMAIN_MODE === "global" ? "global" : "separated",
  };
}

export async function connectionSummary() {
  const saved = await savedConfig();
  const current = saved ?? (await getConnectionConfig());
  return {
    configured: Boolean(current),
    instanceUrl: current?.instanceUrl ?? "",
    username: current?.username ?? "",
    domainMode: current?.domainMode ?? "separated",
    secretStorage: saved
      ? "private local file"
      : current
        ? "environment file"
        : "none",
  };
}

export async function saveConnection(input: {
  instanceUrl: string;
  username: string;
  password?: string;
  domainMode: "separated" | "global";
}) {
  const previous = await getConnectionConfig();
  const instanceUrl = validateUrl(input.instanceUrl);
  const username = input.username.trim();
  const sameAccount =
    previous?.instanceUrl === instanceUrl && previous?.username === username;
  const config: ConnectionConfig = {
    instanceUrl,
    username,
    password: input.password || (sameAccount ? previous?.password : "") || "",
    domainMode: input.domainMode,
  };
  if (config.username.length < 2 || !config.password)
    throw new Error("Enter an account name and password");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const tempPath = join(root, `connection.${randomUUID()}.tmp`);
  await writeFile(tempPath, JSON.stringify(config), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await chmod(tempPath, 0o600);
  await rename(tempPath, configPath);
  await chmod(configPath, 0o600);
  return {
    instanceUrl: config.instanceUrl,
    username: config.username,
    domainMode: config.domainMode,
  };
}
