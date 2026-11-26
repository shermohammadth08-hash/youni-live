# Youni Live — Public (Render free hosting) — Deploy Guide

This folder has the SAME app as Youni Live v6, ready for the public internet.
Your laptop version keeps working on your Wi-Fi exactly as before.
Nothing here changes your laptop files.

## What you need (all free)

1. A GitHub account — https://github.com (Sign up, free)
2. A Render account — https://render.com (Sign up, free, no card needed)

## Steps

### A. Put the code on GitHub

1. On GitHub, click the `+` (top right) → `New repository`.
2. Name it `youni-live`. Keep it Public. Click `Create repository`.
3. On the new repo page, click `uploading an existing file`.
4. Select ALL files from THIS folder and upload them:
   `index.html`, `server.js`, `package.json`, `package-lock.json`,
   `manifest.webmanifest`, `sw.js`, `icon-180.png`, `icon-192.png`,
   `icon-512.png`, `render.yaml`, `DEPLOY-README.md`, `.gitignore`
   (Do NOT upload `node_modules`, `users.json`, `cert.pem`, `key.pem`
   — those are not in this folder anyway.)
5. Click `Commit changes`.

### B. Create the web service on Render

1. On Render, click `New +` → `Web Service`.
2. Connect your GitHub account if asked, and select the `youni-live` repo.
3. Settings (Render fills most of these in from `render.yaml`):
   - Name: `youni-live`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: `Free`
4. Click `Create Web Service`.
5. Wait 2–5 minutes while it builds and deploys.
6. When it says `Live`, open your public link — it looks like:
   `https://youni-live-xxxx.onrender.com`
   (The exact link is shown at the top of your Render dashboard.)

## Use it

- Open the public link on your laptop AND on your phone — from anywhere,
  not just your Wi-Fi. Log in works, chat works, Go Live works.
- The public link has a REAL certificate, so there is no "Not secure"
  warning, and `Install` (Add to Home screen) should work properly.
- IMPORTANT: this is a NEW server. Your laptop accounts do NOT move here.
  Sign up again on the public link with your name and password.

## Free tier limits (Render, checked November 2026)

- The app SLEEPS after 15 minutes with no visitors. The first visitor
  after that waits about 1 minute while it wakes up. This is normal.
- 750 free hours per month per workspace — one app running all month fits.
- 512 MB memory, shared CPU, 5 GB bandwidth per month.
- NO saved data survives a restart: accounts live in `users.json` on the
  server's disk, and Render's free tier wipes the disk on every restart
  or redeploy. If one day your login stops working, just Sign up again
  with the same name.
- Video between different networks uses Google's free STUN server.
  It works in most cases, but not on every network (some strict office
  or mobile networks still block it). A paid TURN server would fix the
  rest — that is a later step, not needed now.
- Sources: render.com/docs/free and render.com/pricing, plus independent
  2026 reviews of Render's free tier.
