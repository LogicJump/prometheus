/**
 * Starter MCP servers for common vendor ecosystems.
 *
 * The value is not the commands — they are in each project's documentation —
 * it is that a user adding "Nordic support" or "ESP-IDF support" should not
 * have to read three README files to discover that the server exists, what it
 * needs installed, and which of its tools are worth granting. These are
 * templates, written into the same MCP settings file the Settings page edits,
 * and fully editable afterwards.
 *
 * Nothing here is applied automatically and nothing is granted automatically:
 * a preset writes a server entry with a note of what it needs, and the normal
 * approval flow still runs the first time the agent calls it.
 */

export interface McpPreset {
  id: string;
  /** Shown in the picker. */
  label: string;
  /** Why a user would add it. */
  description: string;
  /** What has to be on PATH for the server to start. */
  requires?: string;
  server: {
    name: string;
    command: string;
    args: string[];
  };
  /** Documentation URL, so the copied command can be checked. */
  url: string;
}

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "zephyr",
    label: "Zephyr / west",
    description: "Build, flash and inspect Zephyr projects through west. Exposes the workspace's west commands as tools.",
    requires: "west on PATH (pip install west), inside a west workspace",
    server: { name: "zephyr", command: "west", args: ["mcp", "serve"] },
    url: "https://docs.zephyrproject.org/latest/develop/tools/mcp.html",
  },
  {
    id: "esp-idf",
    label: "ESP-IDF",
    description: "ESP-IDF build and flash operations for ESP32-family boards.",
    requires: "The ESP-IDF tools installed (idf.py on PATH)",
    server: { name: "esp-idf", command: "idf.py", args: ["mcp-server"] },
    url: "https://docs.espressif.com/projects/esp-idf/en/latest/esp32/get-started/",
  },
  {
    id: "arduino",
    label: "Arduino CLI",
    description: "Compile and upload sketches through arduino-cli.",
    requires: "arduino-cli on PATH (winget install ArduinoSA.CLI)",
    server: { name: "arduino", command: "arduino-cli", args: ["mcp"] },
    url: "https://arduino.github.io/arduino-cli/latest/",
  },
  {
    id: "probe-rs",
    label: "probe-rs",
    description: "Debug and flash through probe-rs' Rust-based tooling, including RTT.",
    requires: "probe-rs installed (cargo install probe-rs-tools)",
    server: { name: "probe-rs", command: "probe-rs", args: ["mcp"] },
    url: "https://probe.rs/docs/tools/debugger/",
  },
];

export function findPreset(id: string): McpPreset | null {
  return MCP_PRESETS.find((preset) => preset.id === id) ?? null;
}

/**
 * One line per preset, for a tool result or a settings row.
 *
 * A preset whose prerequisite is missing still lists — with `ready: false` and
 * what to install — because hiding it makes the feature look absent rather
 * than unconfigured.
 */
export function describePresets(installed: string[]): { id: string; label: string; ready: boolean; requires?: string; description: string }[] {
  return MCP_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    ready: !preset.requires || installed.includes(preset.server.name),
    ...(preset.requires ? { requires: preset.requires } : {}),
    description: preset.description,
  }));
}
