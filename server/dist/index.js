// src/server.ts
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { example } from "./routers/route-example.js";
import { chat } from "./routers/chat.js";
import { places } from "./routers/places.js";
import { hotels } from "./routers/hotels.js";
dotenv.config();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const app = express();
const corsOptions = {
    origin: [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://calhacks-psi.vercel.app",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json({ limit: "100mb" }));
// routes
app.use("/api/chat", chat);
app.use("/api/places", places);
app.use("/api/hotels", hotels);
app.use("/example", example);
app.get("/", (_req, res) => {
    res.status(200).json({ status: "what's up" });
});
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
