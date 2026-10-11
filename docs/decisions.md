# Decisions

Where the SRS (version 0.3) is silent or ambiguous, this file records how we read it.
Each entry names the SRS sections it rests on and the reading we rejected. The SRS
itself is not ours to change: if an entry turns out to be wrong, we ask the
instructor, then update the entry.

New entries go at the bottom, numbered.

---

## 1. Becoming an organizer means creating an organizer profile

**Decision.** Everyone registers as a regular user. A user becomes an organizer by
creating an organizer profile (`POST /api/me/organizer-profile`), which is
self-service and needs no approval. Creating the profile switches the user's role to
`organizer`. Verification is a separate, later step that gates paid ticket sales
only, never creating events.

**SRS basis.**

- 1.3: an Organizer is "a user who creates and manages an event", so an organizer is
  a kind of user, not a separate account type.
- 4.1: users register with an email, "organizers shall have a profile containing
  contact and payout information", and the system supports role-based permissions.
- 8: organizer profiles are a required MVP feature.
- 3.1 and 3.2: free events need nothing from the organizer. Identity and payout
  verification are listed as steps for activating paid sales.

**Rejected.** A separate organizer sign-up, or a platform admin approving every new
organizer. Neither is in the SRS, and approval would block free events, which 3.1
says organizers can create without charge.

**Where.** `migrations/003_organizer_profiles.sql`, `src/routes/me.ts`, the
"Organizer profile" section of `docs/api.md`.

---

## 2. Event admin rights come from staff assignment, not from the user's role

**Decision.** An organizer puts people on the door of a specific event. Being
assigned to that event is what lets somebody scan its tickets. Any registered user
can be assigned, the organizer included, and assigning does not change their role.
The `event_admin` value of `users.role` opens no event by itself.

**SRS basis.**

- 1.3: an Event Admin is "an organizer-authorized user", authorized by the organizer
  and not by the platform.
- 2.3: organizers "assign check-in staff", and Event Admins "select assigned events".
- 4.8: the app lets them "view only assigned events".
- UC4: the precondition is that the Event Admin is "assigned to the event".
- 6: Staff Assignment is its own data entity.

**Rejected.** Letting the `event_admin` role scan. A role says nothing about which
events, so every event admin would see every event, against 4.8. Changing the role
on assignment was rejected too: one person can be on the door of one event and an
attendee at another, and an organizer may want to scan at their own door.

**Where.** `migrations/002_event_staff.sql`, `src/routes/staff.ts`, the "Staff
assignments" and "Check-in" sections of `docs/api.md`.
