# Paid options

> Draft text, awaiting legal review before the first public release. The seller, the contact address and the prices are placeholders the owner fills in.

Baka is open source and stays that way. Everything needed to run it locally and to build on it is free, with no account and no network: the CLI and the MCP server, the recipes engine, receipts, pins and locks, the starter pack, the contract and its JSON Schemas, the local catalog and the extension point described below. Nothing in the open code is switched off, gated or metered, and it does not phone home.

Paid options are things the open code does not include: a service the owner runs, or a closed package under a commercial license. Payment for Moralo is separate; a Moralo plan neither grants nor requires any of these.

## What there is

| Option | What it is | Kind | Price |
| --- | --- | --- | --- |
| **Private pack registry** | A registry for an organization's own packs, with access control. | Hosted service | [to be set by the owner] |
| **Hosted catalog** | A catalog of approved packs an organization's machines install from, pinned by version and content hash. | Hosted service | [to be set by the owner] |
| **Synced receipts and run history** | Receipts of every run kept for a team, searchable, with the changeset and the pins that produced each one. | Hosted service | [to be set by the owner] |
| **Team features and governance** | Policy over which packs a team may run, and an audit trail. | Closed add-on | [to be set by the owner] |
| **Support** | Help with installation, packs and integration. | Support | [to be set by the owner] |
| **Commercial license** | A commercial license for companies that want one instead of Apache-2.0, with procurement paperwork. | License | [to be set by the owner] |

To ask about any of these: **[contact address, to be set by the owner]**.

## How a paid option attaches

A closed add-on attaches through the one documented extension point of the open engine: `addons` on a call (`--addon <module>` or `BAKA_ADDONS` on the command line, `addons` in the library). An add-on can refuse a run before anything is written and sees every receipt. The extension point is described in [docs/CONTRACT.md](./docs/CONTRACT.md) ("Add-ons"). The open code does not know who made an add-on and never loads one that the caller did not name.

A closed add-on is enforced by its license and by a signed license key: a small token naming the plan, the organization and an expiry, which the add-on verifies offline against a public key. Hosted options are enforced by the service, by account and plan. The open code contains no key checks, because a check in open code can be removed and would contradict the license.

## What stays free

Recipes, packs, the local catalog and installing a pack from a git repository, a directory or a registry you run yourself, are free and unrestricted. A pack you write is yours, under any license you choose; a *private pack* sold or distributed under a commercial license is the pack author's own business.

## Terms

The commercial license and the terms of the hosted services are published when they are offered. This page lists what exists and how to ask; it is not an offer.
