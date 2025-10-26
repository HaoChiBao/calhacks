// server.ts
import dotenv from "dotenv";
import express from "express";
import cors, { type CorsOptions } from "cors";

import { example } from "./routers/route-example";
import { chat } from "./routers/chat";

dotenv.config();

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;

const app = express();

const corsOptions: CorsOptions = {
  origin: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

app.use(cors(corsOptions));

app.use(express.json({ limit: "100mb" }));

// routes
app.use("/api/chat", chat);
app.use("/example", example);

app.get("/", (_req, res) => {
  res.status(200).json({ status: "what's up" });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`); 
});
