# Quix Calendar

Scheduling, task tracking, and attendance for FTC (FIRST Tech Challenge) teams — built as an installable web app (PWA).

**Live:** https://quixcalendar.web.app

## What it does

- **Team calendars** — month / week / day views, recurring events, meetings, tasks, and outreach.
- **Multi-team by design** — every team runs its own space. A captain creates a calendar, shares an invite code, and teammates join. One deployment serves many independent teams; each team only sees its own calendars, members, and events.
- **Roles & leadership** — Captain, Co-Captain, Vice Captain, Programming / Mechanical / Outreach leads, etc. Leaders manage members, roles, and attendance.
- **Attendance** — per-event RSVP, mandatory vs. optional invites, and unexcused-absence tracking.
- **Task dashboard** — priority-based (critical / important / optional) task tracking per subsection.
- **Bug reports & feedback** — built in. Anyone can file a report from the app (Help page or the sidebar link); reports land in a private inbox for the platform owner.
- **Installable PWA** — add to home screen / dock on iOS, Android, macOS, and Windows.

## How teams get started

1. Sign up with an email and password.
2. A starter calendar is created automatically — rename it to your team (double-click the calendar name as an admin, or use the ✎ menu).
3. Open **Share** to get your invite code and send it to teammates.
4. Teammates sign up and use **Join** with the code.

## Tech

- Single-page app: `public/index.html` (vanilla JS, no build step).
- **Firebase Auth** (email/password) + **Cloud Firestore** for data.
- **Firebase Hosting** for delivery. Service worker (`public/sw.js`) provides offline shell + PWA install.

## Data model (Firestore)

| Collection   | Purpose                                                            |
|--------------|-------------------------------------------------------------------|
| `users`      | Profile, display name, avatar, role, unexcused-absence count.     |
| `calendars`  | A team calendar: owner `uid`, name, color, `inviteCode`, `roles`. |
| `events`     | Meetings / tasks / events / outreach, incl. RSVPs and assignees.  |
| `bugReports` | In-app bug reports & feedback (owner-only read).                  |

## Security

Firestore is locked down by `firestore.rules`:

- **No anonymous access** — every read and write requires a signed-in user.
- **Bug reports** are create-only for users and readable only by the platform owner; they can't be edited or deleted from the client.
- Owners/leaders retain the cross-member writes the app needs (assigning roles, marking attendance, RSVPs).

## Deploy

Requires the Firebase CLI and access to the `quixcalendar-fc708` project.

```bash
# Deploy the app to both hosting URLs
firebase deploy --only hosting

# Deploy security rules
firebase deploy --only firestore:rules

# Everything
firebase deploy
```

Hosting serves two URLs from the same `public/` folder:
`https://quixcalendar.web.app` (primary) and `https://quixcalendar-fc708.web.app` (legacy).

## Regenerating app icons

The icons are generated from `icon_source.svg`:

```bash
qlmanage -t -s 512 -o . icon_source.svg      # -> icon_source.svg.png
sips -z 192 192 icon_source.svg.png --out public/icon_192.png
sips -z 512 512 icon_source.svg.png --out public/icon_512.png
sips -z 180 180 icon_source.svg.png --out public/icon_180.png
```
