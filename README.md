# CombinedDashboard

A unified dashboard that merges the **CryptoAnaliz** and **local-web-trading-dashboard** projects.

## Project Structure

```
CombinedDashboard/
├─ frontend/          # React + TypeScript UI
│   ├─ src/
│   │   └─ index.tsx
│   ├─ public/
│   │   └─ index.html
│   └─ package.json
├─ backend/           # Node.js + Express API (monolithic)
│   ├─ src/
│   │   └─ index.js
│   └─ package.json
├─ package.json       # Root scripts & workspace management
└─ README.md          # This file
```

## Development

```bash
# Install all dependencies
npm run install

# Run both frontend and backend concurrently
npm run dev
```

## Build

```bash
npm run build   # Builds the React frontend into `frontend/dist`
```

---
*Feel free to extend this README with deployment instructions, environment variables, and contribution guidelines.*
