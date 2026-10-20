//! User-editable settings, stored as JSON in the OS config directory.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    /// Personal Access Token, kept in the OS keychain.
    Pat,
    /// Microsoft Entra ID sign-in (OAuth 2.0 authorization code + PKCE).
    Entra,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub ado_url: String,
    pub org: String,
    pub project: String,
    pub area_path: String,
    pub board_url: String,
    pub states: Vec<String>,
    pub doing_states: Vec<String>,
    /// States shown in the "New" lane; they are fetched even when missing from `states`.
    pub new_states: Vec<String>,
    pub lookback_days: u32,
    pub refresh_minutes: u32,
    pub title: String,
    pub time_zone: String,
    pub auth_mode: AuthMode,
    /// Entra tenant: a tenant ID, a domain like contoso.com, or "organizations".
    pub tenant_id: String,
    /// Entra app registration (public client) Application ID.
    pub client_id: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ado_url: "https://dev.azure.com".into(),
            org: String::new(),
            project: String::new(),
            area_path: String::new(),
            board_url: String::new(),
            states: vec!["To Do".into(), "Committed".into(), "In Progress".into()],
            doing_states: vec!["In Progress".into()],
            new_states: vec!["New".into()],
            lookback_days: 60,
            refresh_minutes: 10,
            title: "DevOps Team Board".into(),
            time_zone: String::new(),
            auth_mode: AuthMode::Entra,
            tenant_id: "organizations".into(),
            client_id: String::new(),
        }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .map(|s| s.normalized())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| format!("Could not save settings: {e}"))
    }

    /// Trim inputs and fill blanks with sensible defaults.
    pub fn normalized(mut self) -> Self {
        let d = Settings::default();
        let t = |s: &mut String| *s = s.trim().to_string();
        t(&mut self.ado_url);
        t(&mut self.org);
        t(&mut self.project);
        t(&mut self.area_path);
        t(&mut self.board_url);
        t(&mut self.title);
        t(&mut self.time_zone);
        t(&mut self.tenant_id);
        t(&mut self.client_id);
        self.ado_url = self.ado_url.trim_end_matches('/').to_string();
        if self.ado_url.is_empty() {
            self.ado_url = d.ado_url;
        }
        if self.area_path.is_empty() {
            self.area_path = self.project.clone();
        }
        let clean = |v: Vec<String>| v.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>();
        self.states = clean(self.states);
        if self.states.is_empty() {
            self.states = d.states;
        }
        self.doing_states = clean(self.doing_states);
        if self.doing_states.is_empty() {
            self.doing_states = d.doing_states;
        }
        // Left empty on purpose: that turns the "New" lane off.
        self.new_states = clean(self.new_states);
        self.lookback_days = self.lookback_days.clamp(1, 3650);
        self.refresh_minutes = self.refresh_minutes.clamp(1, 1440);
        if self.title.is_empty() {
            self.title = d.title;
        }
        if self.tenant_id.is_empty() {
            self.tenant_id = d.tenant_id;
        }
        self
    }

    pub fn is_configured(&self) -> bool {
        !self.org.is_empty() && !self.project.is_empty()
    }

    /// Every state the board fetches: the "New" lane states, then `states`.
    pub fn query_states(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for s in self.new_states.iter().chain(&self.states) {
            if !out.iter().any(|o| o.eq_ignore_ascii_case(s)) {
                out.push(s.clone());
            }
        }
        out
    }

    pub fn org_url(&self) -> String {
        format!("{}/{}", self.ado_url, enc(&self.org))
    }

    pub fn project_api(&self) -> String {
        format!("{}/{}/_apis", self.org_url(), enc(&self.project))
    }

    pub fn edit_url(&self, id: u64) -> String {
        format!("{}/{}/_workitems/edit/{}", self.org_url(), enc(&self.project), id)
    }

    pub fn effective_board_url(&self) -> String {
        if self.board_url.is_empty() {
            format!("{}/{}/_boards", self.org_url(), enc(&self.project))
        } else {
            self.board_url.clone()
        }
    }
}

pub fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>().replace('+', "%20")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_states_merge_new_lane() {
        let s = Settings::default();
        assert_eq!(s.query_states(), ["New", "To Do", "Committed", "In Progress"]);
        let mut s = Settings { states: vec!["new".into(), "Done".into()], ..Settings::default() };
        assert_eq!(s.query_states(), ["New", "Done"]);
        s.new_states.clear();
        assert_eq!(s.normalized().query_states(), ["new", "Done"]);
    }
}
