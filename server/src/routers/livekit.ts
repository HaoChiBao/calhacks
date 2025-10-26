// import express, { type RequestHandler } from "express";
// import { AccessToken } from "livekit-server-sdk";

// const router = express.Router();

// /**
//  * POST /api/livekit/token
//  * body: { identity?: string, room?: string }
//  * returns: { token, serverUrl, room, identity }
//  */
// export const getToken: RequestHandler = async (req, res) => {
//   const {
//     identity = `user_${Math.random().toString(36).slice(2, 8)}`,
//     room = "trip-planner",
//   } = (req.body ?? {}) as { identity?: string; room?: string };

//   const apiKey = process.env.LIVEKIT_API_KEY!;
//   const apiSecret = process.env.LIVEKIT_API_SECRET!;
//   const serverUrl = process.env.LIVEKIT_WS_URL!; // e.g. wss://your-livekit.example.com

//   if (!apiKey || !apiSecret || !serverUrl) {
//     return res.status(500).json({ error: "LiveKit env is not configured" });
//   }

//   const at = new AccessToken(apiKey, apiSecret, {
//     identity,
//     ttl: 60 * 60, // 1h
//   });
//   at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true });

//   const token = await at.toJwt();
//   res.json({ token, serverUrl, room, identity });
//   return;
// };

// router.post("/token", getToken);

// export const livekit = router;
