use std::path::{Path, PathBuf};

/// The MCP storage shape used by a host tool.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum McpAdapterFormat {
    None,
    JsonObject { field: &'static str },
    JsonObjectCommandArray { field: &'static str },
    TomlTable { field: &'static str },
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
    pub mcp_enabled_field: Option<&'static str>,
    pub software_app_names: &'static [&'static str],
    pub software_executable_names: &'static [&'static str],
}

const CLI_SURFACE: &[&str] = &["cli"];
const DESKTOP_SURFACE: &[&str] = &["desktop"];
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
        mcp_enabled_field: None,
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
        mcp_enabled_field: None,
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
        mcp_enabled_field: None,
        software_app_names: NO_SOFTWARE_NAMES,
        software_executable_names: &["grok"],
    },
    ToolAdapterDefinition {
        id: "mimo-code",
        name: "MiMo Code",
        skills_relative_path: ".config/mimocode/skills",
        mcp_relative_path: ".config/mimocode/mimocode.json",
        install_probe_relative_path: ".mimocode",
        primary_type: "cli",
        surface_types: CLI_SURFACE,
        supports_direct_open: false,
        mcp_format: McpAdapterFormat::JsonObjectCommandArray { field: "mcp" },
        mcp_enabled_field: None,
        software_app_names: NO_SOFTWARE_NAMES,
        software_executable_names: &["mimo"],
    },
    ToolAdapterDefinition {
        id: "workbuddy",
        name: "WorkBuddy",
        skills_relative_path: ".workbuddy/skills",
        mcp_relative_path: ".workbuddy/.mcp.json",
        install_probe_relative_path: ".workbuddy",
        primary_type: "desktop",
        surface_types: DESKTOP_SURFACE,
        supports_direct_open: false,
        mcp_format: McpAdapterFormat::JsonObject {
            field: "mcpServers",
        },
        mcp_enabled_field: None,
        software_app_names: &["WorkBuddy"],
        software_executable_names: NO_SOFTWARE_NAMES,
    },
    ToolAdapterDefinition {
        id: "zcode",
        name: "ZCode",
        skills_relative_path: ".zcode/skills",
        mcp_relative_path: ".zcode/cli/config.json",
        install_probe_relative_path: ".zcode",
        primary_type: "desktop",
        surface_types: DESKTOP_SURFACE,
        supports_direct_open: false,
        mcp_format: McpAdapterFormat::JsonObject {
            field: "mcp.servers",
        },
        mcp_enabled_field: Some("enable"),
        software_app_names: &["ZCode"],
        software_executable_names: NO_SOFTWARE_NAMES,
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
    fn registry_contains_new_hosts_with_expected_paths() {
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
            resolve_skills_path(mimo, &home),
            home.join(".config/mimocode/skills")
        );
        assert_eq!(
            resolve_mcp_path(mimo, &home),
            Some(home.join(".config/mimocode/mimocode.json"))
        );
        assert!(matches!(
            mimo.mcp_format,
            McpAdapterFormat::JsonObjectCommandArray { field: "mcp" }
        ));

        let workbuddy = definition("workbuddy").expect("workbuddy adapter");
        assert_eq!(
            resolve_skills_path(workbuddy, &home),
            home.join(".workbuddy/skills")
        );
        assert_eq!(
            resolve_mcp_path(workbuddy, &home),
            Some(home.join(".workbuddy/.mcp.json"))
        );
        assert!(matches!(
            workbuddy.mcp_format,
            McpAdapterFormat::JsonObject {
                field: "mcpServers"
            }
        ));

        let zcode = definition("zcode").expect("zcode adapter");
        assert_eq!(
            resolve_skills_path(zcode, &home),
            home.join(".zcode/skills")
        );
        assert_eq!(
            resolve_mcp_path(zcode, &home),
            Some(home.join(".zcode/cli/config.json"))
        );
        assert_eq!(zcode.primary_type, "desktop");
        assert_eq!(zcode.surface_types, &["desktop"]);
        assert_eq!(zcode.software_app_names, &["ZCode"]);
        assert_eq!(zcode.mcp_enabled_field, Some("enable"));
        assert!(matches!(
            zcode.mcp_format,
            McpAdapterFormat::JsonObject {
                field: "mcp.servers"
            }
        ));
    }
}
