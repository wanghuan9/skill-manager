use std::path::{Path, PathBuf};

/// The MCP storage shape used by a host tool.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpAdapterFormat {
    None,
    JsonObject { field: &'static str },
    JsonArray { field: &'static str },
    TomlTable { field: &'static str },
}

/// Transport types accepted by a host tool's native MCP configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpTransportPolicy {
    Any,
    StdioOnly,
}

/// Declarative metadata for a host tool added through the adapter registry.
#[derive(Clone, Copy, Debug)]
pub struct ToolAdapterDefinition {
    pub id: &'static str,
    pub name: &'static str,
    pub skills_relative_path: &'static str,
    pub mcp_relative_path: &'static str,
    pub install_probe_relative_path: &'static str,
    pub primary_type: &'static str,
    pub surface_types: &'static [&'static str],
    pub supports_direct_open: bool,
    pub mcp_format: McpAdapterFormat,
    pub mcp_transport_policy: McpTransportPolicy,
    pub software_app_names: &'static [&'static str],
    pub software_executable_names: &'static [&'static str],
}

const CLI_SURFACE: &[&str] = &["cli"];
const NO_SOFTWARE_NAMES: &[&str] = &[];

/// New host tools supported by the extensible adapter path.
pub const TOOL_ADAPTER_DEFINITIONS: &[ToolAdapterDefinition] = &[
    ToolAdapterDefinition {
        id: "pi",
        name: "Pi",
        skills_relative_path: ".pi/agent/skills",
        mcp_relative_path: "",
        install_probe_relative_path: ".pi",
        primary_type: "cli",
        surface_types: CLI_SURFACE,
        supports_direct_open: false,
        mcp_format: McpAdapterFormat::None,
        mcp_transport_policy: McpTransportPolicy::Any,
        software_app_names: NO_SOFTWARE_NAMES,
        software_executable_names: &["pi"],
    },
    ToolAdapterDefinition {
        id: "omp",
        name: "OMP",
        skills_relative_path: ".omp/agent/skills",
        mcp_relative_path: ".omp/agent/mcp.json",
        install_probe_relative_path: ".omp",
        primary_type: "cli",
        surface_types: CLI_SURFACE,
        supports_direct_open: false,
        mcp_format: McpAdapterFormat::JsonObject {
            field: "mcpServers",
        },
        mcp_transport_policy: McpTransportPolicy::Any,
        software_app_names: NO_SOFTWARE_NAMES,
        software_executable_names: &["omp"],
    },
    ToolAdapterDefinition {
        id: "grok",
        name: "Grok Build",
        skills_relative_path: ".grok/skills",
        mcp_relative_path: ".grok/config.toml",
        install_probe_relative_path: ".grok",
        primary_type: "cli",
        surface_types: CLI_SURFACE,
        supports_direct_open: false,
        mcp_format: McpAdapterFormat::TomlTable {
            field: "mcp_servers",
        },
        mcp_transport_policy: McpTransportPolicy::Any,
        software_app_names: NO_SOFTWARE_NAMES,
        software_executable_names: &["grok"],
    },
    ToolAdapterDefinition {
        id: "mimo-code",
        name: "MiMo Code",
        skills_relative_path: ".mimo-code/skills",
        mcp_relative_path: ".mimo-code/config.json",
        install_probe_relative_path: ".mimo-code",
        primary_type: "cli",
        surface_types: CLI_SURFACE,
        supports_direct_open: false,
        mcp_format: McpAdapterFormat::JsonArray {
            field: "mcpServers",
        },
        mcp_transport_policy: McpTransportPolicy::StdioOnly,
        software_app_names: NO_SOFTWARE_NAMES,
        software_executable_names: &["mimo-code"],
    },
];

pub fn definition(tool_id: &str) -> Option<&'static ToolAdapterDefinition> {
    TOOL_ADAPTER_DEFINITIONS
        .iter()
        .find(|definition| definition.id == tool_id)
}

pub fn resolve_skills_path(definition: &ToolAdapterDefinition, home: &Path) -> PathBuf {
    home.join(definition.skills_relative_path)
}

pub fn resolve_mcp_path(definition: &ToolAdapterDefinition, home: &Path) -> Option<PathBuf> {
    if definition.mcp_relative_path.is_empty() {
        None
    } else {
        Some(home.join(definition.mcp_relative_path))
    }
}

#[cfg(test)]
mod tests {
    use super::{definition, resolve_mcp_path, resolve_skills_path, McpAdapterFormat};
    use std::path::PathBuf;

    #[test]
    fn registry_contains_four_new_hosts_with_expected_paths() {
        let home = PathBuf::from("/Users/demo");
        let pi = definition("pi").expect("pi adapter");
        assert_eq!(
            resolve_skills_path(pi, &home),
            home.join(".pi/agent/skills")
        );
        assert!(matches!(pi.mcp_format, McpAdapterFormat::None));

        let omp = definition("omp").expect("omp adapter");
        assert_eq!(
            resolve_mcp_path(omp, &home),
            Some(home.join(".omp/agent/mcp.json"))
        );
        assert!(matches!(
            omp.mcp_format,
            McpAdapterFormat::JsonObject {
                field: "mcpServers"
            }
        ));

        let grok = definition("grok").expect("grok adapter");
        assert_eq!(
            resolve_mcp_path(grok, &home),
            Some(home.join(".grok/config.toml"))
        );
        assert!(matches!(
            grok.mcp_format,
            McpAdapterFormat::TomlTable {
                field: "mcp_servers"
            }
        ));

        let mimo = definition("mimo-code").expect("mimo adapter");
        assert_eq!(
            resolve_mcp_path(mimo, &home),
            Some(home.join(".mimo-code/config.json"))
        );
        assert!(matches!(
            mimo.mcp_format,
            McpAdapterFormat::JsonArray {
                field: "mcpServers"
            }
        ));
    }
}
