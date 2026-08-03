/// Shared publishing eligibility rules.
///
/// Each marketplace adapter identifies whether a package originated from its own store and
/// supplies ownership evidence. This keeps the management policy independent from a specific
/// marketplace implementation so shared publishing can reuse the same rule.
pub(crate) fn supports_publishing_management_owner(management_owner: &str) -> bool {
    matches!(management_owner.trim(), "skilldock" | "agent-skills-cli")
}

pub(crate) fn can_publish_managed_skill(
    management_owner: &str,
    installed_from_target_market: bool,
    has_remote_ownership: bool,
    has_local_publish_binding: bool,
) -> bool {
    if !supports_publishing_management_owner(management_owner) {
        return false;
    }
    if !installed_from_target_market {
        return true;
    }
    has_remote_ownership || has_local_publish_binding
}

#[cfg(test)]
mod tests {
    use super::{can_publish_managed_skill, supports_publishing_management_owner};

    #[test]
    fn accepts_skilldock_and_agent_cli_managed_skills() {
        assert!(supports_publishing_management_owner("skilldock"));
        assert!(supports_publishing_management_owner("agent-skills-cli"));
        assert!(!supports_publishing_management_owner("external"));
    }

    #[test]
    fn excludes_target_market_install_without_ownership() {
        assert!(!can_publish_managed_skill("skilldock", true, false, false));
        assert!(can_publish_managed_skill("skilldock", true, true, false));
        assert!(can_publish_managed_skill(
            "agent-skills-cli",
            true,
            false,
            true
        ));
        assert!(can_publish_managed_skill(
            "agent-skills-cli",
            false,
            false,
            false
        ));
    }
}
