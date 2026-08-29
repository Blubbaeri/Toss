# Toss

Toss is a cross-platform application for instantly sharing notes and files between Desktop (Windows) and Mobile using Supabase Realtime synchronization.

![Build Status](https://img.shields.io/github/actions/workflow/status/USERNAME/toss/build-pc.yml?label=Windows%20Build)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=black)
![Expo](https://img.shields.io/badge/Expo-SDK_54-000020?logo=expo&logoColor=white)

## Table of Contents
- [About the Project](#about-the-project)
- [Key Features](#key-features)
- [System Setup](#system-setup)
- [Installation](#installation)
- [Usage](#usage)
- [Directory Structure](#directory-structure)
- [License](#license)

---

## About the Project
Toss was developed to simplify the often time-consuming transfer of text and files between devices. With an architecture connected directly in real-time to a cloud database (Supabase), users can send data with minimal latency. This system is divided into two main clients: `toss-pc` which runs natively on Windows, and `toss-mobile` which runs on Android/iOS.

---

## Key Features
- Real-time data synchronization using PostgreSQL channels.
- Support for text and image transfers up to 15MB.
- Native Desktop Client with background execution support (System Tray).
- Global keyboard shortcut (`Ctrl+Shift+V`) to summon the app window from anywhere.
- Auto-start automatically when the operating system boots.
- Native Windows notifications when receiving messages from other devices.

---

## System Setup

> [!WARNING]
> **IMPORTANT: Use Your Own Supabase Database!**
> If you clone or fork this repository, you **MUST** create your own [Supabase](https://supabase.com/) account and project. 
> You cannot/must not use the original database credentials belonging to the creator of this repository.

**Setup Steps:**
1. Create a new free project on [Supabase](https://supabase.com/).
2. Create a table named `toss_notes` and enable the *Realtime* feature.
3. Create a public *storage bucket* named `toss_files` to store uploaded files/images.
4. Get the `Project URL` and `anon key` from your Supabase API settings.
5. Create a `.env` file in each client folder, and fill it with your own credentials:

**For PC (`toss-pc/.env`):**
```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_project_anon_key
```

**For Mobile (`toss-mobile/.env`):**
```env
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your_project_anon_key
```

## Installation

Download the repository to your local system:
```bash
git clone https://github.com/USERNAME/toss.git
cd toss
```

### PC Client (Tauri + React)
```bash
cd toss-pc
npm install
npm run tauri dev
```

### Mobile Client (Expo + React Native)
```bash
cd toss-mobile
npm install
npx expo start -c
```

---

## Usage
1. Run the desktop client and let it run in the background.
2. Run the mobile client and scan the QR code using the Expo Go app.
3. Type text or select a file attachment from your phone, then press send.
4. The text or file will instantly appear on the PC client, triggering a native Windows notification if the app window is not in focus.
5. Use `Ctrl+Shift+V` from any app on your PC to quickly open and reply to messages.

---

## Directory Structure
- `/toss-pc` — Source code for the Tauri-based desktop application (React, TypeScript, Rust).
- `/toss-mobile` — Source code for the Expo-based mobile application (React Native, TypeScript).
- `/.github/workflows` — CI/CD configuration for automated `.exe` compilation via GitHub Actions.

---

## License
This project is distributed under the MIT License. Please check the `LICENSE` file for more information.
