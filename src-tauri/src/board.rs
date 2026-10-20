//! Azure DevOps queries, the board snapshot, and the change log.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use crate::settings::Settings;

const FIELDS: &[&str] = &[
    "System.Id",
    "System.Title",
    "System.WorkItemType",
    "System.State",
    "Microsoft.VSTS.Common.Priority",
    "System.AssignedTo",
    "System.CreatedBy",
    "System.Parent",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: u64,
    pub state: String,
    pub raw_state: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub p: i64,
    pub title: String,
    pub owner: Option<String>,
    pub owner_full: Option<String>,
    #[serde(default)]
    pub creator: Option<String>,
    #[serde(default)]
    pub creator_full: Option<String>,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<u64>,
    #[serde(default)]
    pub first_seen: i64,
    #[serde(default)]
    pub owner_changed_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prev_owner: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Parent {
    pub title: String,
    pub state: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Change {
    pub kind: String,
    pub id: u64,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(default)]
    pub at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub updated_at: String,
    pub reason: String,
    pub items: Vec<Item>,
    pub parents: HashMap<String, Parent>,
    pub changes: Vec<Change>,
    /// org/project/area this snapshot belongs to; a settings change starts a fresh log.
    #[serde(default)]
    pub scope: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tracked {
    first_seen: i64,
    owner: Option<String>,
    owner_changed_at: i64,
    #[serde(default)]
    prev_owner: Option<Option<String>>,
    #[serde(default)]
    last_seen: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Tracking {
    #[serde(default)]
    items: HashMap<String, Tracked>,
    #[serde(default)]
    pub history: Vec<Change>,
}

pub struct Store {
    dir: PathBuf,
    pub snapshot: Option<Snapshot>,
    pub tracking: Tracking,
}

impl Store {
    pub fn open(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let snapshot = read_json(&dir.join("snapshot.json"));
        let tracking = read_json(&dir.join("tracking.json")).unwrap_or_default();
        Self { dir, snapshot, tracking }
    }

    pub fn reset(&mut self) {
        self.snapshot = None;
        self.tracking = Tracking::default();
        let _ = std::fs::remove_file(self.dir.join("snapshot.json"));
        let _ = std::fs::remove_file(self.dir.join("tracking.json"));
    }

    fn persist(&self) {
        if let Some(s) = &self.snapshot {
            write_json(&self.dir.join("snapshot.json"), s);
        }
        write_json(&self.dir.join("tracking.json"), &self.tracking);
    }

    /// Merges a fresh fetch into the store and returns what changed since the previous one.
    pub fn apply(&mut self, scope: String, reason: &str, mut items: Vec<Item>, parents: HashMap<String, Parent>) -> Vec<Change> {
        if self.snapshot.as_ref().map(|s| s.scope != scope).unwrap_or(false) {
            self.reset();
        }
        let now = chrono::Utc::now().timestamp_millis();
        let first_run = self.snapshot.is_none();
        let prev: HashMap<u64, Item> = self.snapshot.as_ref().map(|s| s.items.iter().map(|i| (i.id, i.clone())).collect()).unwrap_or_default();
        let next_ids: HashSet<u64> = items.iter().map(|i| i.id).collect();
        let mut changes = Vec::new();

        for it in items.iter_mut() {
            let t = self.tracking.items.entry(it.id.to_string()).or_insert_with(|| Tracked {
                first_seen: if first_run { 0 } else { now },
                owner: it.owner.clone(),
                ..Default::default()
            });
            let old = prev.get(&it.id);
            if old.is_none() && !first_run {
                changes.push(change("added", it, None, Some(it.raw_state.clone()), now));
            }
            if let Some(o) = old {
                if o.raw_state != it.raw_state {
                    changes.push(change("state", it, Some(o.raw_state.clone()), Some(it.raw_state.clone()), now));
                }
            }
            if t.owner != it.owner {
                if !first_run {
                    changes.push(change("owner", it, t.owner.clone(), it.owner.clone(), now));
                }
                t.prev_owner = Some(t.owner.clone());
                t.owner = it.owner.clone();
                t.owner_changed_at = if first_run { 0 } else { now };
            }
            t.last_seen = now;
            it.first_seen = t.first_seen;
            it.owner_changed_at = t.owner_changed_at;
            it.prev_owner = if t.owner_changed_at > 0 { t.prev_owner.clone() } else { None };
        }
        for (id, o) in &prev {
            if !next_ids.contains(id) {
                changes.push(Change { kind: "removed".into(), id: *id, title: o.title.clone(), from: Some(o.raw_state.clone()), to: None, at: now });
            }
        }
        let keep = now - 30 * 86_400_000;
        self.tracking.items.retain(|id, t| next_ids.contains(&id.parse().unwrap_or(0)) || t.last_seen >= keep);
        let mut hist = changes.clone();
        hist.append(&mut self.tracking.history);
        hist.truncate(200);
        self.tracking.history = hist;

        self.snapshot = Some(Snapshot {
            updated_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            reason: reason.into(),
            items,
            parents,
            changes: changes.clone(),
            scope,
        });
        self.persist();
        changes
    }
}

fn change(kind: &str, it: &Item, from: Option<String>, to: Option<String>, at: i64) -> Change {
    Change { kind: kind.into(), id: it.id, title: it.title.clone(), from, to, at }
}

fn read_json<T: for<'de> Deserialize<'de>>(p: &Path) -> Option<T> {
    std::fs::read_to_string(p).ok().and_then(|s| serde_json::from_str(&s).ok())
}

fn write_json<T: Serialize>(p: &Path, v: &T) {
    if let Ok(json) = serde_json::to_string(v) {
        let tmp = p.with_extension("json.tmp");
        if std::fs::write(&tmp, &json).is_ok() && std::fs::rename(&tmp, p).is_err() {
            let _ = std::fs::write(p, &json);
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/* ------------------------------------------------------------ Azure DevOps */

pub struct Ado<'a> {
    pub http: &'a reqwest::Client,
    pub settings: &'a Settings,
    pub auth: String,
}

impl Ado<'_> {
    async fn call(&self, method: reqwest::Method, url: String, body: Option<Value>) -> Result<Value, String> {
        let mut req = self.http.request(method, &url).header("Authorization", &self.auth).header("Accept", "application/json");
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.map_err(|e| {
            if e.is_timeout() {
                "Azure DevOps did not answer within 30 seconds.".to_string()
            } else {
                format!("Could not reach Azure DevOps: {e}")
            }
        })?;
        let status = res.status();
        if status.as_u16() == 203 || status.is_redirection() {
            return Err("Azure DevOps rejected the sign-in (redirected to a login page). Sign in again.".into());
        }
        let text = res.text().await.unwrap_or_default();
        if status.as_u16() == 401 {
            return Err("Unauthorized: the sign-in or PAT is invalid or expired, or lacks Work Items (Read) access.".into());
        }
        if !status.is_success() {
            let msg = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from)).unwrap_or_else(|| text.chars().take(300).collect());
            return Err(format!("Azure DevOps {}: {}", status.as_u16(), msg));
        }
        serde_json::from_str(&text).map_err(|e| format!("Unexpected Azure DevOps response: {e}"))
    }

    /// Returns the signed-in user's display name; proves the credentials work for this org.
    pub async fn whoami(&self) -> Result<String, String> {
        let v = self.call(reqwest::Method::GET, format!("{}/_apis/connectionData", self.settings.org_url()), None).await?;
        let u = &v["authenticatedUser"];
        let name = u["providerDisplayName"].as_str().or_else(|| u["customDisplayName"].as_str()).unwrap_or("").to_string();
        if name.is_empty() || u["id"].as_str() == Some("aa442a37-4ad2-4d13-b13c-9f3ec4a2d7b0") {
            // Anonymous identity: the org did not accept the credentials.
            return Err("Azure DevOps did not accept these credentials for this organization.".into());
        }
        Ok(name)
    }

    async fn batch(&self, ids: &[u64], fields: &[&str]) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        for part in ids.chunks(200) {
            let v = self
                .call(
                    reqwest::Method::POST,
                    format!("{}/wit/workitemsbatch?api-version=7.1", self.settings.project_api()),
                    Some(serde_json::json!({ "ids": part, "fields": fields, "errorPolicy": "Omit" })),
                )
                .await?;
            if let Some(arr) = v["value"].as_array() {
                out.extend(arr.iter().filter(|w| w["id"].as_u64().is_some()).cloned());
            }
        }
        Ok(out)
    }

    pub async fn fetch(&self) -> Result<(Vec<Item>, HashMap<String, Parent>), String> {
        let s = self.settings;
        let q = |v: &str| format!("'{}'", v.replace('\'', "''"));
        let wiql = format!(
            "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AreaPath] UNDER {} AND [System.State] IN ({}) AND [System.ChangedDate] >= @today - {} ORDER BY [System.ChangedDate] DESC",
            q(&s.area_path),
            s.query_states().iter().map(|x| q(x)).collect::<Vec<_>>().join(","),
            s.lookback_days
        );
        let r = self
            .call(reqwest::Method::POST, format!("{}/wit/wiql?api-version=7.1&$top=1000", s.project_api()), Some(serde_json::json!({ "query": wiql })))
            .await?;
        let ids: Vec<u64> = r["workItems"].as_array().map(|a| a.iter().filter_map(|w| w["id"].as_u64()).collect()).unwrap_or_default();
        let raw = if ids.is_empty() { vec![] } else { self.batch(&ids, FIELDS).await? };

        let mut items: Vec<Item> = raw
            .iter()
            .map(|w| {
                let f = &w["fields"];
                let id = w["id"].as_u64().unwrap_or(0);
                let raw_type = f["System.WorkItemType"].as_str().unwrap_or("Task");
                let raw_state = f["System.State"].as_str().unwrap_or("").to_string();
                let (owner, owner_full) = owner_of(&f["System.AssignedTo"]);
                let (creator, creator_full) = owner_of(&f["System.CreatedBy"]);
                let kind = if raw_type == "Product Backlog Item" { "PBI".to_string() } else { raw_type.to_string() };
                let parent = if kind == "Task" { f["System.Parent"].as_u64() } else { None };
                Item {
                    id,
                    state: if s.doing_states.iter().any(|d| d == &raw_state) {
                        "doing".into()
                    } else if s.new_states.iter().any(|d| d == &raw_state) {
                        "new".into()
                    } else {
                        "todo".into()
                    },
                    raw_state,
                    kind,
                    p: f["Microsoft.VSTS.Common.Priority"].as_i64().unwrap_or(2),
                    title: f["System.Title"].as_str().map(String::from).unwrap_or_else(|| format!("Work item {id}")),
                    owner,
                    owner_full,
                    creator,
                    creator_full,
                    url: s.edit_url(id),
                    parent,
                    first_seen: 0,
                    owner_changed_at: 0,
                    prev_owner: None,
                }
            })
            .collect();
        // Keep the server's order (most recently changed first).
        let order: HashMap<u64, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
        items.sort_by_key(|i| order.get(&i.id).copied().unwrap_or(usize::MAX));

        let on_board: HashSet<u64> = items.iter().map(|i| i.id).collect();
        let mut parent_ids: Vec<u64> = items.iter().filter_map(|i| i.parent).filter(|p| !on_board.contains(p)).collect();
        parent_ids.sort_unstable();
        parent_ids.dedup();
        let mut parents = HashMap::new();
        if !parent_ids.is_empty() {
            for w in self.batch(&parent_ids, &["System.Id", "System.Title", "System.State"]).await? {
                let id = w["id"].as_u64().unwrap_or(0);
                parents.insert(
                    id.to_string(),
                    Parent {
                        title: w["fields"]["System.Title"].as_str().map(String::from).unwrap_or_else(|| format!("Work item {id}")),
                        state: w["fields"]["System.State"].as_str().map(String::from),
                        url: s.edit_url(id),
                    },
                );
            }
        }
        for i in items.iter().filter(|i| i.kind != "Task") {
            parents.insert(i.id.to_string(), Parent { title: i.title.clone(), state: Some(i.raw_state.clone()), url: i.url.clone() });
        }
        Ok((items, parents))
    }
}

fn owner_of(v: &Value) -> (Option<String>, Option<String>) {
    let full = match v {
        Value::String(s) => s.clone(),
        Value::Object(_) => v["displayName"].as_str().or_else(|| v["uniqueName"].as_str()).unwrap_or("").to_string(),
        _ => return (None, None),
    };
    let mut clean = String::new();
    let mut depth = 0i32;
    for ch in full.chars() {
        match ch {
            '(' | '<' => depth += 1,
            ')' | '>' => depth = (depth - 1).max(0),
            _ if depth == 0 => clean.push(ch),
            _ => {}
        }
    }
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.is_empty() {
        (None, None)
    } else {
        (clean.split(' ').next().map(String::from), Some(clean))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_names() {
        assert_eq!(owner_of(&serde_json::json!({"displayName": "Alex Doe (Contractor)"})).0.as_deref(), Some("Alex"));
        assert_eq!(owner_of(&serde_json::json!("Sam Roe <sam.roe@example.com>")).1.as_deref(), Some("Sam Roe"));
        assert_eq!(owner_of(&Value::Null), (None, None));
    }

    fn item(id: u64, state: &str, owner: Option<&str>) -> Item {
        Item {
            id,
            state: "todo".into(),
            raw_state: state.into(),
            kind: "PBI".into(),
            p: 2,
            title: format!("t{id}"),
            owner: owner.map(String::from),
            owner_full: None,
            creator: None,
            creator_full: None,
            url: String::new(),
            parent: None,
            first_seen: 0,
            owner_changed_at: 0,
            prev_owner: None,
        }
    }

    #[test]
    fn change_detection() {
        let dir = std::env::temp_dir().join(format!("db-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut s = Store::open(dir.clone());
        let c = s.apply("x".into(), "t", vec![item(1, "To Do", Some("A")), item(2, "To Do", None)], HashMap::new());
        assert!(c.is_empty(), "first run reports nothing");
        let c = s.apply("x".into(), "t", vec![item(1, "In Progress", Some("B")), item(3, "To Do", None)], HashMap::new());
        let kinds: Vec<&str> = c.iter().map(|c| c.kind.as_str()).collect();
        assert!(kinds.contains(&"state") && kinds.contains(&"owner") && kinds.contains(&"added") && kinds.contains(&"removed"), "{kinds:?}");
        let it1 = s.snapshot.as_ref().unwrap().items.iter().find(|i| i.id == 1).unwrap();
        assert!(it1.owner_changed_at > 0);
        assert_eq!(it1.prev_owner, Some(Some("A".into())));
        let it3 = s.snapshot.as_ref().unwrap().items.iter().find(|i| i.id == 3).unwrap();
        assert!(it3.first_seen > 0);
        // Reopen from disk
        let s2 = Store::open(dir.clone());
        assert_eq!(s2.snapshot.unwrap().items.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Runs against a fake Azure DevOps when MOCK_ADO_URL is set (see README → Testing).
    #[tokio::test]
    async fn fetch_against_mock() {
        let Ok(url) = std::env::var("MOCK_ADO_URL") else { return };
        let s = Settings { ado_url: url, org: "contoso".into(), project: "Fabrikam".into(), ..Settings::default() }.normalized();
        let http = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap();
        let ado = Ado { http: &http, settings: &s, auth: crate::auth::basic_header("testpat") };
        assert!(!ado.whoami().await.unwrap().is_empty());
        let (items, parents) = ado.fetch().await.unwrap();
        assert!(items.len() > 10, "{}", items.len());
        assert!(items.iter().any(|i| i.kind == "Task" && i.parent.is_some_and(|p| parents.contains_key(&p.to_string()))));
        assert!(items.iter().any(|i| i.state == "doing"));
        let bad = Ado { http: &http, settings: &s, auth: crate::auth::basic_header("wrong") };
        assert!(bad.fetch().await.unwrap_err().starts_with("Unauthorized"));
    }
}
