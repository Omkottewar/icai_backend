// Barrel export — import everything from here.
// Relations are exported last so drizzle's relational query API
// (db.query.users.findFirst({ with: { … } })) can see every table.
export * from "./enums";
export * from "./files";
export * from "./committees";
export * from "./rooms";
export * from "./identity";
export * from "./payments";
export * from "./events";
export * from "./checklists";
export * from "./firms";
export * from "./ops";
export * from "./counseling";
export * from "./forum";
export * from "./site";
export * from "./notifications";
export * from "./pushSubscriptions";
export * from "./checklistApprovals";
export * from "./eventOverrides";
export * from "./taskAssignments";
export * from "./refunds";
export * from "./bills";
export * from "./iutTransfers";
export * from "./mockTests";
export * from "./mentorship";
export * from "./articleshipMatches";
export * from "./counsellingRequests";
export * from "./scholarships";
export * from "./vendorsAndCategories";
export * from "./budgets";
export * from "./dashboardLayouts";
export * from "./branchContent";
export * from "./grievances";
export * from "./icaiDirectory";
export * from "./pragyaan";
export * from "./studentSuggestions";
export * from "./relations";
