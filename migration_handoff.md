# Handoff: Обединяване на CryptoAnaliz и local-web-trading-dashboard

Този документ съдържа текущия статус и следващите стъпки за прехода към нов чат.

## 📌 Текущ статус

Създадена е основната структура за новия проект **CombinedDashboard** в директория:
`C:\Users\YODA\Desktop\Projects\CombinedDashboard`

### Създадени файлове и директории:
1. **Корен на проекта (`CombinedDashboard/`)**:
   - [`package.json`](file:///C:/Users/YODA/Desktop/Projects/CombinedDashboard/package.json) — Управлява стартирането на двете приложения едновременно чрез `concurrently`.
   - [`README.md`](file:///C:/Users/YODA/Desktop/Projects/CombinedDashboard/README.md) — Документация за инсталация и стартиране.
   - [`.gitignore`](file:///C:/Users/YODA/Desktop/Projects/CombinedDashboard/.gitignore) — Основни правила за игнориране на файлове.
2. **Бекенд (`backend/`)**:
   - Node.js + Express сървър.
   - [`backend/package.json`](file:///C:/Users/YODA/Desktop/Projects/CombinedDashboard/backend/package.json) — Зависимости: `express`, `cors`, `dotenv`.
   - [`backend/src/index.js`](file:///C:/Users/YODA/Desktop/Projects/CombinedDashboard/backend/src/index.js) — Начална точка с базов health endpoint `/api/health`.
   - [`backend/.env`](file:///C:/Users/YODA/Desktop/Projects/CombinedDashboard/backend/.env) — Конфигурационен файл за променливи на средата.
3. **Фронтенд (`frontend/`)**:
   - React + TypeScript с Vite.
   - [`frontend/package.json`](file:///C:/Users/YODA/Desktop/Projects/CombinedDashboard/frontend/package.json) — Зависимости: `react`, `react-dom`, devDependencies за Vite и TS.
   - [`frontend/public/index.html`](file:///C:/Users/YODA/Desktop/Projects/CombinedDashboard/frontend/public/index.html) — Основен HTML темплейт.
   - [`frontend/src/index.tsx`](file:///C:/Users/YODA/Desktop/Projects/CombinedDashboard/frontend/src/index.tsx) — Инициализация на React.
   - [`frontend/src/App.tsx`](file:///C:/Users/YODA/Desktop/Projects/CombinedDashboard/frontend/src/App.tsx) — Базов начален компонент (използващ MUI компоненти).

---

## 🛠️ Какво остана да се донастрои (Следващи стъпки)

Когато започнете новия чат, дайте тези задачи на асистента:

1. **Конфигурация на Фронтенда (Липсващи конфигурационни файлове)**:
   - Създаване на [`frontend/vite.config.ts`](file:///C:/Users/YODA/Desktop/Projects/CombinedDashboard/frontend/vite.config.ts) за конфигуриране на React плъгина и портовете.
   - Създаване на [`frontend/tsconfig.json`](file:///C:/Users/YODA/Desktop/Projects/CombinedDashboard/frontend/tsconfig.json) за TypeScript настройки.
   - Създаване на [`frontend/src/index.css`](file:///C:/Users/YODA/Desktop/Projects/CombinedDashboard/frontend/src/index.css) с дизайн системата (dark mode, HSL цветове, стъклен ефект/glassmorphism).

2. **Инсталация на допълнителни пакети**:
   - Добавяне на MUI зависимости в `frontend` (тъй като `App.tsx` вече ги импортира):
     ```bash
     cd frontend
     npm install @mui/material @emotion/react @emotion/styled
     ```

3. **Копиране и интеграция на код от съществуващите проекти**:
   - **CryptoAnaliz** (`c:\Users\YODA\Desktop\Projects\CryptoAnaliz`) -> прехвърляне на Python анализа/логиката и UI елементите.
   - **local-web-trading-dashboard** (`c:\Users\YODA\Desktop\Projects\local-web-trading-dashboard`) -> прехвърляне на търговските инструменти и визуализации.

---

## 🚀 Как се стартира проектът след инсталация:
В корена на `CombinedDashboard/` изпълнете:
```bash
npm run install   # Ще инсталира пакетите за root, frontend и backend наведнъж
npm run dev       # Ще стартира паралелно React (Vite) на порт 3000 и Express на порт 5000
```
