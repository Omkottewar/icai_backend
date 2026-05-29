// Barrel export — import everything from here.
// Relations are exported last so drizzle's relational query API
// (db.query.users.findFirst({ with: { … } })) can see every table.
export * from "./enums";
export * from "./identity";
export * from "./payments";
export * from "./events";
export * from "./firms";
export * from "./ops";
export * from "./counseling";
export * from "./forum";
export * from "./site";
export * from "./relations";export { files, committees, rooms, articleshipStatusEnum } from "./schema.patch";