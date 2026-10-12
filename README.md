# AI-MedFusion

An educational full-stack mini project: AI Healthcare Analysis, Prediction & Smart Patient Management System.

## Features
- Patient registration and sign-in (bcrypt password hashing and short-lived JWT)
- Appointment booking and token generation
- Queue status dashboard
- Medicine reminder storage and browser notifications while the page is open
- AI general-health chatbot through an API key stored on the server
- Non-diagnostic image description through a vision-capable API
- SQLite database, request validation, upload size/type limits, and API rate limiting

## Requirements
- Node.js 20 or later
- An API key for the AI features (appointment/reminder features work without an AI key)
- Internet connection for installing npm packages and using the AI API

## Run on Windows (PowerShell)
1. Extract the ZIP and open the `AI-MedFusion` folder in VS Code.
2. Open the terminal in that folder.
3. Install packages:
   ```powershell
   npm install
   ```
4. Create `.env` from the example:
   ```powershell
   Copy-Item .env.example .env
   ```
5. Open `.env` and set `OPENAI_API_KEY` and a random `JWT_SECRET` (at least 32 characters).
6. Start the server:
   ```powershell
   npm start
   ```
7. Open `http://localhost:3000` in your browser.

If the native SQLite dependency does not install on your system, install a current Node.js LTS version and retry `npm install`.

## API overview
- `POST /api/auth/register` — `{ "name": "...", "email": "...", "password": "..." }`
- `POST /api/auth/login` — `{ "email": "...", "password": "..." }`
- `GET /api/me` — authenticated profile
- `POST /api/appointments` — `{ "appointmentDate": "YYYY-MM-DD", "reason": "..." }`
- `GET /api/appointments` — current user's appointments
- `GET /api/queue/YYYY-MM-DD` — queue snapshot for a date
- `POST /api/reminders` — `{ "medicineName": "...", "instructions": "...", "reminderTime": "HH:MM" }`
- `GET /api/reminders` — current user's reminders
- `DELETE /api/reminders/:id` — delete a reminder
- `POST /api/chat` — `{ "message": "..." }`
- `POST /api/image-analysis` — multipart form field `image`

Protected endpoints require `Authorization: Bearer <token>`.

## Important limitations before any public deployment
This is a student demonstration, not a production healthcare system.
- AI responses and image descriptions are not medical diagnoses, and must not drive treatment decisions.
- Do not upload identifiable patient images or real patient health records.
- The queue is a simple per-date token counter. It is not a real hospital scheduling/triage system.
- The status-change route is demo-only and currently allows a signed-in user to update only their own appointment; implement a proper staff role and authorization before deployment.
- Browser notifications only work after permission is granted and while the web page is open. They are not a guaranteed alarm or push notification service.
- Use HTTPS, secure session/token handling, audit logs, backups, monitoring, access controls, consent, and applicable privacy/health-data laws before handling real patient information.
- A production disease-prediction system requires clinically validated datasets, evaluation by qualified clinicians, bias/safety testing, regulatory review where applicable, and secure clinical workflows. This project deliberately does not predict diseases from medical images.
