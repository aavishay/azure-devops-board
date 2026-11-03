//! One ticket in full, for the ticket panel: fields, rich text, links, discussion and
//! history, plus the quick edits (state, assignee, priority) and new comments.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::board::{owner_of, text_to_html, write_error, Ado};
use crate::settings::enc;

/// Rich-text fields shown when they have content, in this order.
const SECTIONS: &[(&str, &str)] = &[
    ("System.Description", "Description"),
    ("Microsoft.VSTS.TCM.ReproSteps", "Repro steps"),
    ("Microsoft.VSTS.Common.AcceptanceCriteria", "Acceptance criteria"),
    ("Microsoft.VSTS.TCM.SystemInfo", "System info"),
];

/// Fields whose changes the history lists.
const TRACKED: &[(&str, &str)] = &[
    ("System.State", "State"),
    ("System.AssignedTo", "Assigned to"),
    ("Microsoft.VSTS.Common.Priority", "Priority"),
    ("System.IterationPath", "Iteration"),
    ("System.Title", "Title"),
];

const COMMENTS_API: &str = "api-version=7.1-preview.4";
const PRIORITY: &str = "Microsoft.VSTS.Common.Priority";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    pub id: u64,
    /// The revision opened; an edit is refused if the ticket has moved on since.
    pub rev: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub state: String,
    pub reason: Option<String>,
    pub assigned_to: Option<Person>,
    pub priority: Option<i64>,
    pub has_priority: bool,
    pub area: String,
    pub iteration: String,
    pub tags: Vec<String>,
    pub created_by: Option<String>,
    pub created_at: Option<String>,
    pub changed_by: Option<String>,
    pub changed_at: Option<String>,
    pub url: String,
    /// Azure DevOps HTML, as stored. The UI cleans it before showing it.
    pub sections: Vec<Section>,
    pub states: Vec<StateInfo>,
    pub parent: Option<Link>,
    pub children: Vec<Link>,
    /// Newest first.
    pub comments: Vec<Comment>,
    /// Newest first.
    pub history: Vec<HistoryEntry>,
    /// Parts that couldn't be loaded, so the panel can say so instead of showing them empty.
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Person {
    pub name: String,
    pub unique: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Section {
    pub label: String,
    pub html: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StateInfo {
    pub name: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Link {
    pub id: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Comment {
    pub author: String,
    pub at: String,
    pub html: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HistoryEntry {
    pub by: String,
    pub at: String,
    pub created: bool,
    pub changes: Vec<FieldChange>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FieldChange {
    pub field: String,
    pub from: Option<String>,
    pub to: Option<String>,
}

/// A quick edit from the panel. Only the fields that changed are present; an empty
/// `assigned_to` unassigns.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketEdit {
    pub id: u64,
    pub rev: u64,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub assigned_to: Option<String>,
    #[serde(default)]
    pub priority: Option<i64>,
}

pub const STALE: &str = "Someone changed this ticket since you opened it, so nothing was saved. It now shows the latest; make your change again.";

impl Ado<'_> {
    pub async fn ticket(&self, id: u64) -> Result<Ticket, String> {
        let api = self.settings.project_api();
        let w = self.call(reqwest::Method::GET, format!("{api}/wit/workitems/{id}?$expand=relations&api-version=7.1"), None).await?;
        let f = &w["fields"];
        let kind = f["System.WorkItemType"].as_str().unwrap_or("").to_string();
        let (parent_id, child_ids) = hierarchy(&w["relations"]);
        let linked: Vec<u64> = parent_id.into_iter().chain(child_ids.iter().copied()).collect();

        let (ty, comments, updates, links) = tokio::join!(
            self.call(reqwest::Method::GET, format!("{api}/wit/workitemtypes/{}?api-version=7.1", enc(&kind)), None),
            self.call(reqwest::Method::GET, format!("{api}/wit/workItems/{id}/comments?$top=50&order=desc&{COMMENTS_API}"), None),
            self.call(reqwest::Method::GET, format!("{api}/wit/workItems/{id}/updates?$top=200&api-version=7.1"), None),
            async {
                if linked.is_empty() {
                    Ok(vec![])
                } else {
                    self.batch(&linked, &["System.Id", "System.Title", "System.State", "System.WorkItemType"]).await
                }
            },
        );

        let mut missing = Vec::new();
        let link_of = |id: u64, ws: &[Value]| {
            let w = ws.iter().find(|w| w["id"].as_u64() == Some(id));
            let g = |k: &str| w.and_then(|w| w["fields"][k].as_str()).unwrap_or("").to_string();
            Link { id, kind: g("System.WorkItemType"), title: if w.is_some() { g("System.Title") } else { format!("Work item {id}") }, state: g("System.State") }
        };
        let links = links.unwrap_or_else(|_| {
            missing.push("linked tickets' titles".to_string());
            vec![]
        });
        let state = f["System.State"].as_str().unwrap_or("").to_string();
        let (states, has_priority) = match &ty {
            Ok(t) => type_info(t),
            Err(_) => {
                missing.push("the list of states".into());
                (vec![], f.get(PRIORITY).is_some())
            }
        };
        let comments = match &comments {
            Ok(c) => parse_comments(c),
            Err(_) => {
                missing.push("the discussion".into());
                vec![]
            }
        };
        let history = match &updates {
            Ok(u) => history(u),
            Err(_) => {
                missing.push("the history".into());
                vec![]
            }
        };
        let (_, assigned_full) = owner_of(&f["System.AssignedTo"]);
        let name = |k: &str| owner_of(&f[k]).1;
        let s = |k: &str| f[k].as_str().map(String::from);

        Ok(Ticket {
            id,
            rev: w["rev"].as_u64().unwrap_or(0),
            title: s("System.Title").unwrap_or_else(|| format!("Work item {id}")),
            reason: s("System.Reason"),
            assigned_to: assigned_full.map(|name| Person { name, unique: f["System.AssignedTo"]["uniqueName"].as_str().filter(|u| !u.is_empty()).map(String::from) }),
            priority: f[PRIORITY].as_i64(),
            has_priority,
            area: s("System.AreaPath").unwrap_or_default(),
            iteration: s("System.IterationPath").unwrap_or_default(),
            tags: f["System.Tags"].as_str().map(|t| t.split(';').map(str::trim).filter(|t| !t.is_empty()).map(String::from).collect()).unwrap_or_default(),
            created_by: name("System.CreatedBy"),
            created_at: s("System.CreatedDate"),
            changed_by: name("System.ChangedBy"),
            changed_at: s("System.ChangedDate"),
            url: self.settings.edit_url(id),
            sections: SECTIONS
                .iter()
                .filter_map(|(k, label)| f[*k].as_str().filter(|h| !h.trim().is_empty()).map(|h| Section { label: label.to_string(), html: h.to_string() }))
                .collect(),
            states: if states.is_empty() { vec![StateInfo { name: state.clone(), category: String::new() }] } else { states },
            parent: parent_id.map(|p| link_of(p, &links)),
            children: child_ids.iter().map(|c| link_of(*c, &links)).collect(),
            kind,
            state,
            comments,
            history,
            missing,
        })
    }

    /// Applies a quick edit, refusing it if the ticket changed since `edit.rev`.
    pub async fn edit(&self, edit: &TicketEdit) -> Result<(), String> {
        let ops = edit_ops(edit);
        if ops.len() < 2 {
            return Err("Nothing to save: no field changed.".into());
        }
        let api = self.settings.project_api();
        let req = self
            .http
            .patch(format!("{api}/wit/workitems/{}?api-version=7.1", edit.id))
            .header("Content-Type", "application/json-patch+json")
            .body(Value::Array(ops).to_string());
        match self.send(req).await {
            Ok(_) => Ok(()),
            Err(e) => {
                // A failed /rev test reads differently across Azure DevOps versions, so ask.
                let now = self.call(reqwest::Method::GET, format!("{api}/wit/workitems/{}?fields=System.Rev&api-version=7.1", edit.id), None).await;
                if now.is_ok_and(|w| w["rev"].as_u64().is_some_and(|r| r != edit.rev)) {
                    Err(STALE.into())
                } else {
                    Err(write_error(e))
                }
            }
        }
    }

    pub async fn comment(&self, id: u64, text: &str) -> Result<(), String> {
        let api = self.settings.project_api();
        self.call(reqwest::Method::POST, format!("{api}/wit/workItems/{id}/comments?{COMMENTS_API}"), Some(json!({ "text": text_to_html(text) })))
            .await
            .map(|_| ())
            .map_err(write_error)
    }
}

fn link_id(url: &str) -> Option<u64> {
    url.rsplit('/').next()?.parse().ok()
}

/// The parent and the children, from a work item's relations.
fn hierarchy(relations: &Value) -> (Option<u64>, Vec<u64>) {
    let mut parent = None;
    let mut children = Vec::new();
    for r in relations.as_array().into_iter().flatten() {
        let Some(id) = r["url"].as_str().and_then(link_id) else { continue };
        match r["rel"].as_str() {
            Some("System.LinkTypes.Hierarchy-Reverse") => parent = Some(id),
            Some("System.LinkTypes.Hierarchy-Forward") => children.push(id),
            _ => {}
        }
    }
    (parent, children)
}

/// The type's states in workflow order, and whether it has a priority field.
fn type_info(t: &Value) -> (Vec<StateInfo>, bool) {
    let states = t["states"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| Some(StateInfo { name: s["name"].as_str()?.to_string(), category: s["category"].as_str().unwrap_or("").to_string() }))
        .collect();
    let has_priority = t["fields"].as_array().into_iter().flatten().any(|f| f["referenceName"].as_str() == Some(PRIORITY));
    (states, has_priority)
}

fn parse_comments(v: &Value) -> Vec<Comment> {
    v["comments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| !c["isDeleted"].as_bool().unwrap_or(false))
        .map(|c| Comment {
            author: owner_of(&c["createdBy"]).1.unwrap_or_else(|| "Someone".into()),
            at: c["createdDate"].as_str().unwrap_or("").to_string(),
            html: c["text"].as_str().unwrap_or("").to_string(),
        })
        .collect()
}

fn shown(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        Value::String(s) => Some(s.clone()),
        Value::Object(_) => owner_of(v).1,
        other => Some(other.to_string()),
    }
}

/// Creation and changes to the tracked fields, newest first, at most 20.
fn history(updates: &Value) -> Vec<HistoryEntry> {
    let mut out: Vec<HistoryEntry> = updates["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|u| {
            let f = &u["fields"];
            // revisedDate is when a revision was replaced (year 9999 for the latest), so prefer ChangedDate.
            let at = f["System.ChangedDate"]["newValue"].as_str().or_else(|| u["revisedDate"].as_str().filter(|d| !d.starts_with("9999"))).unwrap_or("").to_string();
            let by = owner_of(&u["revisedBy"]).1.unwrap_or_else(|| "Someone".into());
            if u["rev"].as_u64() == Some(1) {
                return Some(HistoryEntry { by, at, created: true, changes: vec![] });
            }
            let changes: Vec<FieldChange> = TRACKED
                .iter()
                .filter_map(|(k, label)| {
                    let c = f.get(*k)?;
                    let (from, to) = (shown(&c["oldValue"]), shown(&c["newValue"]));
                    (from != to).then(|| FieldChange { field: label.to_string(), from, to })
                })
                .collect();
            (!changes.is_empty()).then_some(HistoryEntry { by, at, created: false, changes })
        })
        .collect();
    out.reverse();
    out.truncate(20);
    out
}

fn edit_ops(e: &TicketEdit) -> Vec<Value> {
    let mut ops = vec![json!({ "op": "test", "path": "/rev", "value": e.rev })];
    if let Some(s) = e.state.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        ops.push(json!({ "op": "add", "path": "/fields/System.State", "value": s }));
    }
    match e.assigned_to.as_deref().map(str::trim) {
        Some("") => ops.push(json!({ "op": "remove", "path": "/fields/System.AssignedTo" })),
        Some(who) => ops.push(json!({ "op": "add", "path": "/fields/System.AssignedTo", "value": who })),
        None => {}
    }
    if let Some(p) = e.priority {
        ops.push(json!({ "op": "add", "path": format!("/fields/{PRIORITY}"), "value": p }));
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_and_children() {
        let r = json!([
            { "rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://dev.azure.com/contoso/_apis/wit/workItems/10" },
            { "rel": "System.LinkTypes.Hierarchy-Forward", "url": "https://dev.azure.com/contoso/_apis/wit/workItems/21" },
            { "rel": "System.LinkTypes.Hierarchy-Forward", "url": "https://dev.azure.com/contoso/_apis/wit/workItems/22" },
            { "rel": "System.LinkTypes.Related", "url": "https://dev.azure.com/contoso/_apis/wit/workItems/30" },
            { "rel": "AttachedFile", "url": "https://dev.azure.com/contoso/_apis/wit/attachments/abc" },
        ]);
        assert_eq!(hierarchy(&r), (Some(10), vec![21, 22]));
        assert_eq!(hierarchy(&Value::Null), (None, vec![]));
    }

    #[test]
    fn history_lists_tracked_changes_newest_first() {
        let u = json!({ "value": [
            { "rev": 1, "revisedBy": { "displayName": "Alex Doe" }, "fields": { "System.ChangedDate": { "newValue": "2026-11-01T09:00:00Z" } } },
            { "rev": 2, "revisedBy": { "displayName": "Sam Roe (Contractor)" }, "revisedDate": "9999-01-01T00:00:00Z", "fields": {
                "System.ChangedDate": { "oldValue": "2026-11-01T09:00:00Z", "newValue": "2026-11-02T10:00:00Z" },
                "System.State": { "oldValue": "New", "newValue": "In Progress" },
                "System.AssignedTo": { "newValue": { "displayName": "Sam Roe", "uniqueName": "sam.roe@example.com" } },
                "System.Description": { "newValue": "<p>more</p>" },
            } },
            { "rev": 3, "revisedBy": { "displayName": "Sam Roe" }, "fields": { "System.Description": { "oldValue": "a", "newValue": "b" } } },
        ]});
        let h = history(&u);
        assert_eq!(h.len(), 2, "description-only updates are left out");
        assert_eq!(h[0].by, "Sam Roe");
        assert_eq!(h[0].at, "2026-11-02T10:00:00Z");
        assert_eq!(h[0].changes, vec![
            FieldChange { field: "State".into(), from: Some("New".into()), to: Some("In Progress".into()) },
            FieldChange { field: "Assigned to".into(), from: None, to: Some("Sam Roe".into()) },
        ]);
        assert!(h[1].created && h[1].by == "Alex Doe");
    }

    #[test]
    fn edit_patch() {
        let e = TicketEdit { id: 5, rev: 7, state: Some("Done".into()), assigned_to: Some(String::new()), priority: Some(1) };
        let ops = edit_ops(&e);
        assert_eq!(ops[0], json!({ "op": "test", "path": "/rev", "value": 7 }));
        assert_eq!(ops[1], json!({ "op": "add", "path": "/fields/System.State", "value": "Done" }));
        assert_eq!(ops[2], json!({ "op": "remove", "path": "/fields/System.AssignedTo" }));
        assert_eq!(ops[3]["value"], 1);
        let who = TicketEdit { state: None, assigned_to: Some("sam.roe@example.com".into()), priority: None, ..e };
        assert_eq!(edit_ops(&who)[1], json!({ "op": "add", "path": "/fields/System.AssignedTo", "value": "sam.roe@example.com" }));
        assert_eq!(edit_ops(&TicketEdit { assigned_to: None, ..who }).len(), 1, "only the rev test: nothing to save");
    }

    #[test]
    fn type_states_and_priority() {
        let t = json!({ "states": [{ "name": "New", "category": "Proposed" }, { "name": "Done", "category": "Completed" }], "fields": [{ "referenceName": PRIORITY }] });
        let (s, p) = type_info(&t);
        assert_eq!(s.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["New", "Done"]);
        assert!(p);
        assert!(!type_info(&json!({})).1);
    }

    /// Loads and edits a ticket on a fake Azure DevOps whose copy is at revision 4.
    #[tokio::test]
    async fn open_and_edit_against_fake_server() {
        use axum::{body::Bytes, http::{Method, StatusCode, Uri}, response::IntoResponse};
        let app = axum::Router::new().fallback(|m: Method, u: Uri, body: Bytes| async move {
            let p = u.path();
            let v = match (m.as_str(), p) {
                ("GET", p) if p.ends_with("/wit/workitems/7") && u.query().unwrap_or("").contains("System.Rev") => json!({ "id": 7, "rev": 4 }),
                ("GET", p) if p.ends_with("/wit/workitems/7") => json!({ "id": 7, "rev": 4,
                    "fields": { "System.WorkItemType": "Bug", "System.Title": "Login loops", "System.State": "New", "System.Tags": "web; auth",
                        "System.AssignedTo": { "displayName": "Sam Roe", "uniqueName": "sam.roe@example.com" },
                        "Microsoft.VSTS.TCM.ReproSteps": "<p>Sign out, then in</p>", "System.Description": "" },
                    "relations": [{ "rel": "System.LinkTypes.Hierarchy-Reverse", "url": "http://x/_apis/wit/workItems/10" }] }),
                ("GET", p) if p.ends_with("/wit/workitemtypes/Bug") => json!({ "states": [{ "name": "New" }, { "name": "Done" }], "fields": [{ "referenceName": PRIORITY }] }),
                ("GET", p) if p.ends_with("/comments") => json!({ "comments": [{ "createdBy": { "displayName": "Alex Doe" }, "createdDate": "2026-11-02T10:00:00Z", "text": "<div>Seen it</div>" }] }),
                ("GET", p) if p.ends_with("/updates") => json!({ "value": [] }),
                ("POST", p) if p.ends_with("/workitemsbatch") => json!({ "value": [{ "id": 10, "fields": { "System.Title": "Auth rework", "System.State": "Committed", "System.WorkItemType": "Product Backlog Item" } }] }),
                ("PATCH", _) => {
                    let ops: Value = serde_json::from_slice(&body).unwrap();
                    if ops[0]["value"] != 4 {
                        return (StatusCode::PRECONDITION_FAILED, axum::Json(json!({ "message": "TF26071: changed by someone else" }))).into_response();
                    }
                    if ops[1]["value"] == "Bogus" {
                        return (StatusCode::BAD_REQUEST, axum::Json(json!({ "message": "TF401320: Rule Error for field State" }))).into_response();
                    }
                    json!({ "id": 7, "rev": 5 })
                }
                _ => return StatusCode::NOT_FOUND.into_response(),
            };
            axum::Json(v).into_response()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, app).await });
        let s = crate::settings::Settings { ado_url: format!("http://127.0.0.1:{port}"), org: "contoso".into(), project: "Fabrikam".into(), ..Default::default() }.normalized();
        let http = reqwest::Client::new();
        let ado = Ado { http: &http, settings: &s, auth: "Basic ok".into() };

        let t = ado.ticket(7).await.unwrap();
        assert_eq!((t.rev, t.kind.as_str(), t.state.as_str()), (4, "Bug", "New"));
        assert_eq!(t.assigned_to, Some(Person { name: "Sam Roe".into(), unique: Some("sam.roe@example.com".into()) }));
        assert_eq!(t.tags, ["web", "auth"]);
        assert_eq!(t.sections.iter().map(|s| s.label.as_str()).collect::<Vec<_>>(), ["Repro steps"], "empty Description is left out");
        assert_eq!(t.states.len(), 2);
        assert!(t.has_priority);
        assert_eq!(t.parent.as_ref().map(|p| (p.id, p.title.as_str())), Some((10, "Auth rework")));
        assert_eq!(t.comments[0].author, "Alex Doe");
        assert!(t.missing.is_empty(), "{:?}", t.missing);

        let edit = |rev, state: &str| TicketEdit { id: 7, rev, state: Some(state.into()), assigned_to: None, priority: None };
        ado.edit(&edit(4, "Done")).await.unwrap();
        assert_eq!(ado.edit(&edit(3, "Done")).await.unwrap_err(), STALE);
        let rule = ado.edit(&edit(4, "Bogus")).await.unwrap_err();
        assert!(rule.contains("TF401320"), "{rule}");
    }

    #[test]
    fn deleted_comments_are_left_out() {
        let c = json!({ "comments": [
            { "createdBy": { "displayName": "Alex Doe" }, "createdDate": "2026-11-02T10:00:00Z", "text": "<div>Looks good</div>" },
            { "createdBy": { "displayName": "Sam Roe" }, "isDeleted": true, "text": "gone" },
        ]});
        let c = parse_comments(&c);
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].author.as_str(), c[0].html.as_str()), ("Alex Doe", "<div>Looks good</div>"));
    }
}
