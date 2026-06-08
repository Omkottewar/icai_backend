import { relations } from "drizzle-orm";
import {
  branches, users, roles, userRoleAssignments,
  employers, employerUsers,
  memberProfiles, studentProfiles,
  oauthLinks,
} from "./identity";
import { payments } from "./payments";
import { events, eventRegistrations, cpeCredits } from "./events";
import { firms, jobPostings } from "./firms";
import { roomBookings } from "./ops";
import { consultations, cabfAssistanceRequests } from "./counseling";

// ─── Identity ────────────────────────────────────────────────────────────────

export const branchesRelations = relations(branches, ({ many }) => ({
  users:  many(users),
  events: many(events),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  assignments: many(userRoleAssignments),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  branch:              one(branches, { fields: [users.branch_id], references: [branches.id] }),
  memberProfile:       one(memberProfiles, { fields: [users.id], references: [memberProfiles.user_id] }),
  studentProfile:      one(studentProfiles, { fields: [users.id], references: [studentProfiles.user_id] }),
  oauthLinks:          many(oauthLinks),
  roleAssignments:     many(userRoleAssignments),
  employerMemberships: many(employerUsers),
  payments:            many(payments),
  eventRegistrations:  many(eventRegistrations),
  cpeCredits:          many(cpeCredits),
  jobPostings:         many(jobPostings),
  consultationsAsClient: many(consultations, { relationName: "client" }),
  cabfRequests:        many(cabfAssistanceRequests),
  roomBookings:        many(roomBookings),
}));

export const userRoleAssignmentsRelations = relations(userRoleAssignments, ({ one }) => ({
  user: one(users, { fields: [userRoleAssignments.user_id], references: [users.id] }),
  role: one(roles, { fields: [userRoleAssignments.role_id], references: [roles.id] }),
}));

export const employersRelations = relations(employers, ({ many }) => ({
  employerUsers: many(employerUsers),
  jobPostings:   many(jobPostings),
}));

export const employerUsersRelations = relations(employerUsers, ({ one }) => ({
  employer: one(employers, { fields: [employerUsers.employer_id], references: [employers.id] }),
  user:     one(users,     { fields: [employerUsers.user_id],     references: [users.id] }),
}));

export const memberProfilesRelations = relations(memberProfiles, ({ one }) => ({
  user: one(users, { fields: [memberProfiles.user_id], references: [users.id] }),
}));

export const studentProfilesRelations = relations(studentProfiles, ({ one }) => ({
  user:            one(users, { fields: [studentProfiles.user_id],             references: [users.id] }),
  principalMember: one(users, { fields: [studentProfiles.principal_member_id], references: [users.id] }),
}));

export const oauthLinksRelations = relations(oauthLinks, ({ one }) => ({
  user: one(users, { fields: [oauthLinks.user_id], references: [users.id] }),
}));

// ─── Payments ────────────────────────────────────────────────────────────────

export const paymentsRelations = relations(payments, ({ one }) => ({
  payer: one(users, { fields: [payments.payer_user_id], references: [users.id] }),
}));

// ─── Events ──────────────────────────────────────────────────────────────────

export const eventsRelations = relations(events, ({ one, many }) => ({
  branch:        one(branches, { fields: [events.branch_id],   references: [branches.id] }),
  createdBy:     one(users,    { fields: [events.created_by],  references: [users.id] }),
  parent:        one(events,   { fields: [events.recurrence_parent_id], references: [events.id], relationName: "recurrence" }),
  children:      many(events,  { relationName: "recurrence" }),
  registrations: many(eventRegistrations),
  cpeCredits:    many(cpeCredits),
}));

export const eventRegistrationsRelations = relations(eventRegistrations, ({ one }) => ({
  event:   one(events,   { fields: [eventRegistrations.event_id],   references: [events.id] }),
  user:    one(users,    { fields: [eventRegistrations.user_id],    references: [users.id] }),
  payment: one(payments, { fields: [eventRegistrations.payment_id], references: [payments.id] }),
}));

export const cpeCreditsRelations = relations(cpeCredits, ({ one }) => ({
  user:  one(users,  { fields: [cpeCredits.user_id],  references: [users.id] }),
  event: one(events, { fields: [cpeCredits.event_id], references: [events.id] }),
}));

// ─── Firms ───────────────────────────────────────────────────────────────────

export const firmsRelations = relations(firms, ({ many }) => ({
  jobPostings: many(jobPostings),
}));

export const jobPostingsRelations = relations(jobPostings, ({ one }) => ({
  posterUser: one(users,     { fields: [jobPostings.poster_user_id], references: [users.id] }),
  employer:   one(employers, { fields: [jobPostings.employer_id],    references: [employers.id] }),
  firm:       one(firms,     { fields: [jobPostings.firm_id],        references: [firms.id] }),
  payment:    one(payments,  { fields: [jobPostings.payment_id],     references: [payments.id] }),
}));

// ─── Ops ─────────────────────────────────────────────────────────────────────

export const roomBookingsRelations = relations(roomBookings, ({ one }) => ({
  user:    one(users,    { fields: [roomBookings.user_id],    references: [users.id] }),
  payment: one(payments, { fields: [roomBookings.payment_id], references: [payments.id] }),
}));

// ─── Counseling ──────────────────────────────────────────────────────────────

export const consultationsRelations = relations(consultations, ({ one }) => ({
  clientUser: one(users,    { fields: [consultations.client_user_id], references: [users.id], relationName: "client" }),
  payment:    one(payments, { fields: [consultations.payment_id],     references: [payments.id] }),
}));

export const cabfAssistanceRequestsRelations = relations(cabfAssistanceRequests, ({ one }) => ({
  memberUser:           one(users,    { fields: [cabfAssistanceRequests.member_user_id],          references: [users.id] }),
  reviewerUser:         one(users,    { fields: [cabfAssistanceRequests.reviewer_user_id],        references: [users.id] }),
  disbursementPayment:  one(payments, { fields: [cabfAssistanceRequests.disbursement_payment_id], references: [payments.id] }),
}));
