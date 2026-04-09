# 🏴‍☠️ Kaizoku Server

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2018.0.0-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Stack](https://img.shields.io/badge/Stack-Node.js%20%7C%20Express%20%7C%20MongoDB-purple)](https://expressjs.com/)
[![Scraper](https://img.shields.io/badge/Scraper-Puppeteer-orange)](https://pptr.dev/)

> **Kaizoku** (海賊) — A high-performance, automated anime streaming backend that orchestrates metadata aggregation and content scraping to deliver a seamless viewing experience.

---

## 🚀 Key Features

- **⚡ High-Performance Scraper**: Leverages Puppeteer with stealth plugins to bypass detection and extract high-quality streaming links from various sources.
- **📊 Metadata Orchestration**: Integrates with AniList API to fetch rich metadata, including synopses, ratings, and artwork.
- **🛡️ Secure API**: Implementation of `helmet`, `cors`, and `express-rate-limit` to ensure data integrity and protection against common web vulnerabilities.
- **🔄 Scalable Engine**: A robust scraping engine capable of handling concurrent tasks and automated data seeding.
- **🗃️ Flexible Database**: Optimized MongoDB schemas for fast retrieval of anime details and streaming sources.

---

## 🛠️ Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: MongoDB (Mongoose)
- **Scraping**: Puppeteer, Puppeteer Extra (Stealth)
- **Authentication/Security**: rate-limit, helmet, CORS
- **Logging**: Morgan

---

## 📦 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher)
- [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) or a local MongoDB instance
- `npm` or `yarn`

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/your-repo/kaizoku-server.git
   cd kaizoku-server
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure Environment Variables**
   Create a `.env` file in the root directory:
   ```env
   PORT=5000
   MONGODB_URI=your_mongodb_connection_string
   NODE_ENV=development
   TARGET_URL=https://gogoanime.by
   SCRAPE_CONCURRENCY=3
   ```

4. **Run the Server**
   ```bash
   # For development (with nodemon)
   npm run dev

   # For production
   npm start
   ```

### Scraping Content
To manually trigger the scraping engine:
```bash
npm run scrape
```

---

## 📡 API Endpoints

| Endpoint | Method | Description |
|:---|:---|:---|
| `/api/health` | `GET` | Health check for the API |
| `/api/anime` | `GET` | List available anime from database |
| `/api/anime/:id` | `GET` | Get detailed information for a specific anime |

---

## ⚖️ Legal Disclaimer

> [!CAUTION]
> **This project is for educational purposes only.**
>
> Kaizoku does not host any media files. The software is designed to index content found on third-party websites. Users are responsible for complying with the terms of use of the source websites.
>
> The developers of this project:
> 1. Do not condone or encourage copyright infringement.
> 2. Are not responsible for how users utilize this software.
> 3. Do not have any affiliation with the content providers.

---

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

<p align="center">
  Built with ❤️ by the <b>Kaizoku Team</b>
</p>
