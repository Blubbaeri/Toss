# Toss

Toss adalah aplikasi lintas perangkat untuk berbagi catatan dan file secara instan antara Desktop (Windows) dan Mobile menggunakan sinkronisasi Supabase Realtime.

![Build Status](https://img.shields.io/github/actions/workflow/status/USERNAME/toss/build-pc.yml?label=Windows%20Build)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Tauri](https://img.shields.io/badge/Tauri-v2-FFC131?logo=tauri&logoColor=black)
![Expo](https://img.shields.io/badge/Expo-SDK_54-000020?logo=expo&logoColor=white)

## Table of Contents
- [Tentang Proyek](#tentang-proyek)
- [Fitur Utama](#fitur-utama)
- [Persiapan Sistem](#persiapan-sistem)
- [Instalasi](#instalasi)
- [Penggunaan](#penggunaan)
- [Struktur Direktori](#struktur-direktori)
- [Lisensi](#lisensi)

---

## Tentang Proyek
Toss dikembangkan untuk menyederhanakan transfer teks dan file antar perangkat yang seringkali memakan waktu. Dengan arsitektur yang terhubung langsung secara realtime ke database cloud (Supabase), pengguna dapat mengirim data dengan latensi minimal. Sistem ini dibagi menjadi dua klien utama: `toss-pc` yang berjalan secara native di Windows, dan `toss-mobile` yang berjalan di Android/iOS.

---

## Fitur Utama
- Sinkronisasi realtime data menggunakan channel PostgreSQL.
- Dukungan transfer teks dan gambar hingga 15MB.
- Klien Desktop Native dengan dukungan berjalan di latar belakang (System Tray).
- Pintasan keyboard global (`Ctrl+Shift+V`) untuk memanggil jendela aplikasi dari mana saja.
- Auto-start otomatis saat sistem operasi melakukan booting.
- Notifikasi native Windows saat menerima pesan dari perangkat lain.

---

## Persiapan Sistem
> **Catatan:** Pastikan environment variable `.env` sudah dikonfigurasi di setiap direktori klien (`toss-pc` dan `toss-mobile`) sebelum menjalankan aplikasi.

Anda memerlukan konfigurasi kredensial Supabase berikut agar sinkronisasi dapat berjalan:
- `VITE_SUPABASE_URL` (PC) / `EXPO_PUBLIC_SUPABASE_URL` (Mobile)
- `VITE_SUPABASE_ANON_KEY` (PC) / `EXPO_PUBLIC_SUPABASE_ANON_KEY` (Mobile)

---

## Instalasi

Unduh repositori ke sistem lokal Anda:
```bash
git clone https://github.com/USERNAME/toss.git
cd toss
```

### Klien PC (Tauri + React)
```bash
cd toss-pc
npm install
npm run tauri dev
```

### Klien Mobile (Expo + React Native)
```bash
cd toss-mobile
npm install
npx expo start -c
```

---

## Penggunaan
1. Jalankan klien desktop dan biarkan berjalan di background.
2. Jalankan klien mobile dan pindai kode QR menggunakan aplikasi Expo Go.
3. Ketik teks atau pilih lampiran file dari ponsel Anda, lalu tekan tombol kirim.
4. Teks atau file akan seketika muncul di klien PC, memicu notifikasi native Windows jika jendela aplikasi tidak sedang fokus.
5. Gunakan `Ctrl+Shift+V` dari aplikasi apa pun di PC Anda untuk segera membuka dan membalas pesan.

---

## Struktur Direktori
- `/toss-pc` — Kode sumber aplikasi desktop berbasis Tauri (React, TypeScript, Rust).
- `/toss-mobile` — Kode sumber aplikasi mobile berbasis Expo (React Native, TypeScript).
- `/.github/workflows` — Konfigurasi CI/CD untuk otomatisasi kompilasi `.exe` via GitHub Actions.

---

## Lisensi
Proyek ini didistribusikan di bawah lisensi MIT. Silakan periksa berkas `LICENSE` untuk informasi lebih lanjut.
