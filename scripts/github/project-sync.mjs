const DEFAULTS = {
  owner: "johnlombardo-dev",
  projectNumber: 1,
  repository: "johnlombardo-dev/agent-mail",
};

const OWNER_ATTENTION = new Set([238, 241]);
const LIVE_ATTENTION = new Set([177, 181]);
const SECURITY_ATTENTION = new Set([183, 184, 185]);
const EXTERNAL_ATTENTION = new Set([180, 219]);

const FIELD_NAMES = [
  "Status",
  "Phase",
  "Workstream",
  "Work type",
  "Queue",
  "Evidence",
  "Attention",
  "Size",
  "Forecast confidence",
  "Start date",
  "Target date",
];

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function addBusinessDays(dateValue, count) {
  const date = new Date(`${dateValue}T12:00:00Z`);
  let remaining = count;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return isoDate(date);
}

function nextBusinessDay(dateValue) {
  return addBusinessDays(dateValue, 1);
}

function titleTags(title) {
  return [...title.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
}

export function classifyIssue(issue) {
  const tags = titleTags(issue.title);
  const first = tags[0] ?? "";
  const joined = `${tags.join(" ")} ${issue.title}`.toLowerCase();
  const phaseNumbers = [...first.matchAll(/P([0-8])/g)].map((match) => Number(match[1]));

  let phase = "Cross-phase";
  const phaseTracker = first.match(/^Phase ([0-8])$/);
  if (first === "Post-release") phase = "Post-release";
  else if (phaseTracker) phase = `P${phaseTracker[1]}`;
  else if (phaseNumbers.length === 1) phase = `P${phaseNumbers[0]}`;
  else if (phaseNumbers.length > 1) phase = "Cross-phase";
  else if (first === "Foundation") phase = "P0";

  let workType = "Implementation";
  if (first === "Program") workType = "Program";
  else if (first.startsWith("Phase ")) workType = "Phase";
  else if (first === "Domain") workType = "Domain";
  else if (first === "Intervention") workType = "Intervention";
  else if (joined.includes("corrective")) workType = "Corrective";
  else if (/\b(freeze|design|planning)\b/.test(joined)) workType = "Design";
  else if (/\b(qualify|qualification|verify|review)\b/.test(joined)) workType = "Qualification";

  const area = `${tags[1] ?? ""} ${first === "Domain" ? issue.title.replace(/^\[Domain\]\s*/, "") : ""}`.toLowerCase();
  let workstream = "Foundation";
  const mappings = [
    [/credential/, "Credentials"],
    [/platform|linux|provider/, "Platforms"],
    [/product|demo|readme|agent readiness/, "Product and demo"],
    [/qualification|security|quality/, "Qualification"],
    [/operation|deployment|administration|setup|launchd|tailscale/, "Operations"],
    [/report|agent and report/, "Reports"],
    [/\bcli\b|interface/, "CLI"],
    [/rest|http|public surface/, "REST API"],
    [/action|authorization|remote mutation/, "Actions"],
    [/routing/, "Routing"],
    [/search|query/, "Search"],
    [/synchronization|imap|workflow|lifecycle/, "Sync"],
    [/storage|database|blob|mime|backup|recovery/, "Storage"],
    [/contract/, "Contracts"],
    [/domain|model/, "Domain"],
    [/architecture|boundar/, "Architecture"],
    [/foundation|toolchain|repository|port/, "Foundation"],
  ];
  for (const [pattern, value] of mappings) {
    if (pattern.test(area)) {
      workstream = value;
      break;
    }
  }
  if (workType === "Phase") {
    const phaseStreams = {
      P0: "Foundation",
      P1: "Contracts",
      P2: "Storage",
      P3: "Sync",
      P4: "Search",
      P5: "Actions",
      P6: "REST API",
      P7: "Operations",
      P8: "Qualification",
    };
    workstream = phaseStreams[phase] ?? workstream;
  }

  const sizeMatch = issue.title.match(/\[(Compact|Full)\/(?:low|medium|high|xhigh|max)\]/i);
  const effortMatch = issue.title.match(/\[(?:Compact|Full)\/(low|medium|high|xhigh|max)\]/i);

  return {
    phase,
    workType,
    workstream,
    size: sizeMatch?.[1] ?? null,
    effort: effortMatch?.[1]?.toLowerCase() ?? null,
  };
}

export function durationBusinessDays(issue) {
  const { size, effort } = classifyIssue(issue);
  if (size === "Compact") return 1;
  if (size === "Full" && (effort === "xhigh" || effort === "max")) return 3;
  if (size === "Full") return 2;
  return null;
}

function minDate(values) {
  return values.filter(Boolean).sort()[0] ?? null;
}

function maxDate(values) {
  return values.filter(Boolean).sort().at(-1) ?? null;
}

export function buildForecasts(issues, today = isoDate(new Date())) {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const memo = new Map();

  function forecast(issue, visiting = new Set()) {
    if (memo.has(issue.number)) return memo.get(issue.number);
    if (issue.state === "CLOSED") {
      const actual = {
        start: isoDate(issue.createdAt),
        target: isoDate(issue.closedAt ?? issue.updatedAt),
        confidence: "High",
      };
      memo.set(issue.number, actual);
      return actual;
    }
    if (visiting.has(issue.number)) {
      return { start: null, target: null, confidence: "Unscheduled" };
    }

    const classification = classifyIssue(issue);
    if (classification.phase === "Post-release") {
      const unscheduled = { start: null, target: null, confidence: "Unscheduled" };
      memo.set(issue.number, unscheduled);
      return unscheduled;
    }

    const nextVisiting = new Set(visiting).add(issue.number);
    const openChildren = (issue.subIssues?.nodes ?? [])
      .map((child) => byNumber.get(child.number))
      .filter((child) => child?.state === "OPEN");
    if (openChildren.length > 0) {
      const children = openChildren.map((child) => forecast(child, nextVisiting));
      const parent = {
        start: minDate(children.map((child) => child.start)),
        target: maxDate(children.map((child) => child.target)),
        confidence: "Low",
      };
      memo.set(issue.number, parent);
      return parent;
    }

    const duration = durationBusinessDays(issue);
    if (!duration) {
      const unscheduled = { start: null, target: null, confidence: "Unscheduled" };
      memo.set(issue.number, unscheduled);
      return unscheduled;
    }

    const blockers = (issue.blockedBy?.nodes ?? [])
      .map((blocker) => byNumber.get(blocker.number))
      .filter((blocker) => blocker?.state === "OPEN");
    const blockerForecasts = blockers.map((blocker) => forecast(blocker, nextVisiting));
    const blockerTarget = maxDate(blockerForecasts.map((blocker) => blocker.target));
    if (blockers.length > 0 && !blockerTarget) {
      const unscheduled = { start: null, target: null, confidence: "Unscheduled" };
      memo.set(issue.number, unscheduled);
      return unscheduled;
    }

    const start = blockerTarget ? nextBusinessDay(blockerTarget) : today;
    const result = {
      start,
      target: addBusinessDays(start, duration - 1),
      confidence: blockers.length > 0 ? "Low" : "Medium",
    };
    memo.set(issue.number, result);
    return result;
  }

  for (const issue of issues) forecast(issue);
  return memo;
}

function attentionFor(number) {
  if (OWNER_ATTENTION.has(number)) return "Owner";
  if (LIVE_ATTENTION.has(number)) return "Live authorization";
  if (SECURITY_ATTENTION.has(number)) return "Security";
  if (EXTERNAL_ATTENTION.has(number)) return "External";
  return "None";
}

function desiredValues(issue, forecasts) {
  const classification = classifyIssue(issue);
  const forecast = forecasts.get(issue.number);
  const openBlockers = (issue.blockedBy?.nodes ?? []).filter((blocker) => blocker.state === "OPEN");
  const openChildren = (issue.subIssues?.nodes ?? []).filter((child) => child.state === "OPEN");
  const isTracker = ["Program", "Phase", "Domain", "Intervention"].includes(classification.workType);

  let status = issue.state === "CLOSED" ? "Done" : "Todo";
  if (issue.state === "OPEN" && (issue.number === 238 || openChildren.length > 0)) status = "In Progress";

  let queue = null;
  if (issue.state === "OPEN" && classification.phase === "Post-release") queue = "Post-release";
  else if (issue.state === "OPEN" && !isTracker && openBlockers.length === 0) queue = "Now";
  else if (issue.state === "OPEN" && !isTracker && openBlockers.length > 0) queue = "Next";
  else if (issue.state === "OPEN") queue = "Later";

  let evidence = "Planned";
  if (issue.state === "CLOSED" && ["Implementation", "Corrective"].includes(classification.workType)) {
    evidence = "Implemented";
  }
  if (issue.number === 238 && issue.state === "OPEN") evidence = "Implemented";

  return {
    Status: status,
    Phase: classification.phase,
    Workstream: classification.workstream,
    "Work type": classification.workType,
    Queue: queue,
    Evidence: evidence,
    Attention: issue.state === "OPEN" ? attentionFor(issue.number) : null,
    Size: classification.size,
    "Forecast confidence": forecast?.confidence ?? "Unscheduled",
    "Start date": forecast?.start ?? null,
    "Target date": forecast?.target ?? null,
  };
}

export function buildRelationshipOperations(issues) {
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const phaseParents = new Map();
  for (const issue of issues) {
    const match = issue.title.match(/^\[Phase ([0-8])\]/);
    if (match) phaseParents.set(`P${match[1]}`, issue);
  }

  const operations = [];
  for (const issue of issues) {
    const { phase, workType } = classifyIssue(issue);
    const phaseParent = phaseParents.get(phase);
    if (phaseParent && workType !== "Phase" && !issue.parent) {
      operations.push({ kind: "subIssue", issue: phaseParent, subIssue: issue });
    }

    const dependencyPattern = /Corrective dependency for (?:\[#(\d+)\]\([^)]+\)|#(\d+))/gi;
    for (const match of issue.body.matchAll(dependencyPattern)) {
      const targetNumber = Number(match[1] ?? match[2]);
      const target = byNumber.get(targetNumber);
      if (!target) throw new Error(`Issue #${issue.number} references missing dependency target #${targetNumber}`);
      const alreadyLinked = (target.blockedBy?.nodes ?? []).some(
        (blocker) => blocker.number === issue.number,
      );
      if (!alreadyLinked) operations.push({ kind: "blockedBy", issue: target, blocker: issue });
    }
  }
  return operations;
}

async function github(token, query, variables = {}) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "agent-mail-project-sync",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(`GitHub GraphQL failed: ${JSON.stringify(payload.errors ?? payload)}`);
  }
  return payload.data;
}

async function loadProject(token, owner, projectNumber) {
  const data = await github(
    token,
    `query($owner:String!,$number:Int!){
      user(login:$owner){
        projectV2(number:$number){
          id
          fields(first:100){nodes{
            ... on ProjectV2Field {id name dataType}
            ... on ProjectV2SingleSelectField {id name options{id name}}
          }}
        }
      }
    }`,
    { owner, number: projectNumber },
  );
  const project = data.user?.projectV2;
  if (!project) throw new Error(`Project ${owner}/${projectNumber} was not found`);
  const fields = new Map(project.fields.nodes.filter(Boolean).map((field) => [field.name, field]));
  for (const name of FIELD_NAMES) {
    if (!fields.has(name)) throw new Error(`Required Project field is missing: ${name}`);
  }
  return { id: project.id, fields };
}

async function loadIssues(token, repository) {
  const [owner, name] = repository.split("/");
  const issues = [];
  let after = null;
  do {
    const data = await github(
      token,
      `query($owner:String!,$name:String!,$after:String){
        repository(owner:$owner,name:$name){
          issues(first:100,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){
            pageInfo{hasNextPage endCursor}
            nodes{
              id number title body state createdAt updatedAt closedAt url
              labels(first:50){nodes{name}}
              parent{number}
              subIssues(first:100){nodes{number state}}
              blockedBy(first:50){nodes{number state}}
            }
          }
        }
      }`,
      { owner, name, after },
    );
    const page = data.repository.issues;
    issues.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return issues;
}

async function applyRelationshipOperations(token, operations, dryRun) {
  if (dryRun) return;
  for (const operation of operations) {
    if (operation.kind === "subIssue") {
      await github(
        token,
        `mutation($issue:ID!,$subIssue:ID!){addSubIssue(input:{issueId:$issue,subIssueId:$subIssue}){issue{id}}}`,
        { issue: operation.issue.id, subIssue: operation.subIssue.id },
      );
      continue;
    }
    await github(
      token,
      `mutation($issue:ID!,$blocker:ID!){addBlockedBy(input:{issueId:$issue,blockingIssueId:$blocker}){issue{id}}}`,
      { issue: operation.issue.id, blocker: operation.blocker.id },
    );
  }
}

async function loadItems(token, owner, projectNumber) {
  const items = [];
  let after = null;
  do {
    const data = await github(
      token,
      `query($owner:String!,$number:Int!,$after:String){
        user(login:$owner){projectV2(number:$number){items(first:100,after:$after){
          pageInfo{hasNextPage endCursor}
          nodes{
            id
            content{... on Issue{id number}}
            fieldValues(first:100){nodes{
              ... on ProjectV2ItemFieldSingleSelectValue {name optionId field{... on ProjectV2FieldCommon{name}}}
              ... on ProjectV2ItemFieldDateValue {date field{... on ProjectV2FieldCommon{name}}}
            }}
          }
        }}}
      }`,
      { owner, number: projectNumber, after },
    );
    const page = data.user.projectV2.items;
    items.push(...page.nodes.filter((item) => item.content?.number));
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return items;
}

function currentValues(item) {
  const values = new Map();
  for (const value of item.fieldValues.nodes) {
    const name = value.field?.name;
    if (name) values.set(name, value.name ?? value.date ?? null);
  }
  return values;
}

function optionId(field, value) {
  const option = field.options?.find((candidate) => candidate.name === value);
  if (!option) throw new Error(`Field ${field.name} has no option named ${value}`);
  return option.id;
}

async function addMissingItems(token, projectId, issues, items, dryRun) {
  const present = new Set(items.map((item) => item.content.number));
  const missing = issues.filter((issue) => !present.has(issue.number));
  if (dryRun || missing.length === 0) return missing.length;
  for (const issue of missing) {
    await github(
      token,
      `mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}`,
      { project: projectId, content: issue.id },
    );
  }
  return missing.length;
}

function buildOperations(project, issues, items, forecasts) {
  const itemByNumber = new Map(items.map((item) => [item.content.number, item]));
  const operations = [];
  for (const issue of issues) {
    const item = itemByNumber.get(issue.number);
    if (!item) continue;
    const current = currentValues(item);
    for (const [fieldName, desired] of Object.entries(desiredValues(issue, forecasts))) {
      const field = project.fields.get(fieldName);
      const existing = current.get(fieldName) ?? null;
      if (existing === desired) continue;
      operations.push({ itemId: item.id, field, desired, issueNumber: issue.number });
    }
  }
  return operations;
}

function operationSource(projectId, operation, index) {
  const common = `projectId:${JSON.stringify(projectId)},itemId:${JSON.stringify(operation.itemId)},fieldId:${JSON.stringify(operation.field.id)}`;
  if (operation.desired === null) {
    return `o${index}:clearProjectV2ItemFieldValue(input:{${common}}){projectV2Item{id}}`;
  }
  const isSelect = Array.isArray(operation.field.options);
  const value = isSelect
    ? `singleSelectOptionId:${JSON.stringify(optionId(operation.field, operation.desired))}`
    : `date:${JSON.stringify(operation.desired)}`;
  return `o${index}:updateProjectV2ItemFieldValue(input:{${common},value:{${value}}}){projectV2Item{id}}`;
}

async function applyOperations(token, projectId, operations, dryRun) {
  if (dryRun) return;
  for (let offset = 0; offset < operations.length; offset += 10) {
    const batch = operations.slice(offset, offset + 10);
    const query = `mutation { ${batch.map((operation, index) => operationSource(projectId, operation, index)).join(" ")} }`;
    try {
      await github(token, query);
    } catch (error) {
      if (batch.length === 1) throw error;
      for (const operation of batch) {
        await github(token, `mutation { ${operationSource(projectId, operation, 0)} }`);
      }
    }
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const token = process.env.GH_PROJECT_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error("GH_PROJECT_TOKEN or GH_TOKEN is required");
  const owner = process.env.PROJECT_OWNER ?? DEFAULTS.owner;
  const projectNumber = Number(process.env.PROJECT_NUMBER ?? DEFAULTS.projectNumber);
  const repository = process.env.REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? DEFAULTS.repository;
  const project = await loadProject(token, owner, projectNumber);
  let issues = await loadIssues(token, repository);
  const relationshipOperations = buildRelationshipOperations(issues);
  await applyRelationshipOperations(token, relationshipOperations, dryRun);
  if (!dryRun && relationshipOperations.length > 0) issues = await loadIssues(token, repository);
  let items = await loadItems(token, owner, projectNumber);
  const missing = await addMissingItems(token, project.id, issues, items, dryRun);
  if (!dryRun && missing > 0) items = await loadItems(token, owner, projectNumber);
  const forecasts = buildForecasts(issues, process.env.FORECAST_TODAY);
  const operations = buildOperations(project, issues, items, forecasts);
  await applyOperations(token, project.id, operations, dryRun);
  console.log(
    JSON.stringify({
      dryRun,
      issueCount: issues.length,
      projectItemCount: items.length,
      missingItems: missing,
      relationshipUpdates: relationshipOperations.length,
      fieldUpdates: operations.length,
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
