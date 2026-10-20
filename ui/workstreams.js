/*
 * Workstream grouping for the board. Edit freely; no rebuild needed (just reload the page).
 *  - OVERRIDES pins a work item (or a parent PBI, which its tasks then inherit) to a workstream.
 *  - RULES are tried in order against the title; the first match wins.
 * Machine-specific pins can go in workstreams.local.js (git-ignored), which is loaded after this file.
 */
window.WORKSTREAMS = {
  ORDER: ["Certificates", "Security", "Platform", "Observability", "CI/CD", "Other"],
  OVERRIDES: {
    // 12345: "Security",   // pin work item 12345 (and its tasks) to a workstream
  },
  RULES: [
    ["Certificates", /cert/i],
    ["CI/CD", /pipeline|ci\/cd|approval gate|coverage|autoscaling|terraform|atlantis/i],
    ["Observability", /alert|trace|observab|monitor|service health|hud|grafana/i],
    ["Security", /rotat|key|public access|securitycontext|waf|database user|secret|pen.?test|rate limit/i],
    ["Platform", /aks|k8s|redis|node pool|\bvm\b|helm|orphan|cluster|vendor|integration|environment|argocd|gpu|cosmos/i],
  ],
};
