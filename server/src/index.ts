import cors from "cors";
import axios from "axios";
import { db } from "./db";
import dotenv from "dotenv";
import router from "./routes";
import { parse } from "cookie";
import passport from "passport";
import Room from "./utils/roomClass";
import cookieParser from "cookie-parser";
import { verifyToken } from "./utils/jwt";
import { JwtPayload } from "jsonwebtoken";
import express, { Application } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer, IncomingMessage } from "http";
import { jwtStrategy } from "./middlewares/auth-middleware";

dotenv.config();

export type User = {
  id: string;
  username: string;
};
interface AuthIncomingMessage extends IncomingMessage {
  user?: User;
}

interface ClientMessage {
  type: string;
  [key: string]: any;
}

const app: Application = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

const port = process.env.PORT || 3000;

app.use(passport.initialize());
app.use(express.json());
app.use(cookieParser());
app.use(
  cors({
    credentials: true,
    origin: process.env.APP_URL,
  })
);
app.use(router);

passport.use("jwt", jwtStrategy);

export const rooms: Map<string, Room> = new Map();
export const users: Map<string, string> = new Map();

server.on("upgrade", async (req: AuthIncomingMessage, socket, head) => {
  try {
    const cookies = parse(req.headers.cookie || "");
    const token = cookies.access_token;
    if (!token) return socket.destroy();
    const decodedToken = verifyToken(
      token,
      process.env.ACCESS_TOKEN_SECRET!
    ) as JwtPayload;
    const user = await db.user.findUnique({
      where: { id: decodedToken.userId },
      select: { id: true, username: true },
    });
    if (!user) return socket.destroy();
    req.user = { id: user.id, username: user.username };
    wss.handleUpgrade(req, socket, head, function done(ws) {
      wss.emit("connection", ws, req);
    });
  } catch (error) {
    console.error("WebSocket upgrade error ", error);
    return socket.destroy();
  }
});

wss.on("connection", (ws, req: AuthIncomingMessage) => {
  const user = req.user;
  if (!user) {
    ws.close(1008, "Authentication required");
    return;
  }
  ws.on("message", (message: string) => handleMessage(user, ws, message));
  ws.on("close", () => handleClose(user, ws));
});

const handleMessage = (user: User, ws: WebSocket, message: string) => {
  let parsedMessage: ClientMessage;
  try {
    parsedMessage = JSON.parse(message.toString()) as ClientMessage;
  } catch (error) {
    console.error("Failed to parse WebSocket message:", error);
    return;
  }
  const { type, ...data } = parsedMessage;
  switch (type) {
    case "join-room": {
      handleJoinRoom(user, ws, data.room_id);
      break;
    }
    case "generate-questions": {
      handleQuestionGeneration(user, ws, data.topic, data.difficulty);
      break;
    }
    case "start-quiz": {
      startQuiz(user, ws);
      break;
    }
    case "add-response": {
      addResponse(user, ws, data.question_number, data.option);
      break;
    }
    case "reset-quiz": {
      resetGame(user, ws);
      break;
    }
  }
};

const handleClose = (user: User, ws: WebSocket) => {
  const isUserInAGame = users.get(user.username);
  if (isUserInAGame) {
    const room = rooms.get(isUserInAGame);
    const removed = room?.removeUser(user.username, ws);
    if (removed) users.delete(user.username);
  }
};

const handleJoinRoom = (user: User, ws: WebSocket, room_id: string) => {
  const room = rooms.get(room_id);
  const isUserInAGame = users.get(user.username);
  let message: string = "";

  if (!room)
    message = "Could not find the room, please join or create another room!";
  else if (isUserInAGame) message = "You are already in another room!";

  if (message) {
    const response = {
      success: false,
      type: "joined",
      message,
    };
    broadcastEventToSingleUser(response, ws);
    return;
  }

  const newUser = {
    username: user.username,
    score: 0,
    ws,
    is_admin: user.username === room!.admin_username,
  };
  const joined = room!.addUser(newUser);
  if (joined) users.set(user.username, room_id);
  return;
};

const handleQuestionGeneration = async (
  user: User,
  ws: WebSocket,
  topic: string,
  difficulty: "Easy" | "Medium" | "Hard"
) => {
  let message: string = "";
  let room: Room | undefined;
  const validDifficulties = ["Easy", "Medium", "Hard"];

  const roomId = users.get(user.username);

  if (!roomId) {
    message = "You are not in a room.";
  } else {
    room = rooms.get(roomId);

    if (!room) {
      message = "Room not found.";
    } else if (user.username !== room.admin_username) {
      message = "Only the room admin can generate questions.";
    } else if (!topic?.trim()?.length) {
      message = "Topic cannot be empty.";
    } else if (!validDifficulties.includes(difficulty)) {
      message = `Invalid difficulty: ${difficulty}. Must be one of ${validDifficulties.join(
        ", "
      )}.`;
    }
  }

  if (message?.length) {
    const responseString = JSON.stringify({
      success: false,
      type: "questions",
      message: message,
    });
    ws.send(responseString);
    return;
  }

  try {
    const response = await axios.post(`${process.env.GET_QUIZZES_URL}`, {
      topic,
      difficulty,
    });
    const questions = response?.data;
    if (!questions?.length) {
      return ws.send(
        JSON.stringify({
          type: "questions",
          success: false,
          message:
            response?.data?.message ||
            "Could not generate the questions, please try again",
        })
      );
    } else room?.setQuestions(questions, user.username);
  } catch (error) {
    console.error("Error generating questions:", error);
    const errorResponseString = JSON.stringify({
      success: false,
      type: "questions",
      message: "Failed to generate questions. Please try again.",
    });
    ws.send(errorResponseString);
  }
};

const startQuiz = (user: User, ws: WebSocket) => {
  try {
    let room: Room | undefined;
    const roomId = users.get(user.username);
    let message: string = "";
    if (!roomId) {
      message = "You are not in a room.";
    } else {
      room = rooms.get(roomId);

      if (!room) {
        message = "Room not found.";
      } else if (user.username !== room.admin_username) {
        message = "Only the room admin can generate questions.";
      } else if (room.current_state !== "waiting") {
        message = "The quiz has already begun.";
      }
    }
    if (message?.length) {
      const responseString = JSON.stringify({
        success: false,
        type: "start-quiz",
        message: message,
      });
      ws.send(responseString);
      return;
    }
    room?.startQuiz();
  } catch (error) {
    console.error("Error starting quiz:", error);
    const errorResponseString = JSON.stringify({
      success: false,
      type: "start-quiz",
      message: "Failed to start quiz. Please try again.",
    });
    ws.send(errorResponseString);
  }
};

const addResponse = (
  user: User,
  ws: WebSocket,
  question_number: number,
  option: string
) => {
  let room: Room | undefined;
  const roomId = users.get(user.username);
  let message: string = "";
  if (!roomId) {
    message = "You are not in a room.";
  } else {
    room = rooms.get(roomId);

    if (!room) {
      message = "Room not found.";
    } else if (room.current_state !== "quiz") {
      message = "Not accepting answers now.";
    }
  }
  if (message?.length) {
    const responseString = JSON.stringify({
      success: false,
      type: "response",
      message: message,
    });
    ws.send(responseString);
    return;
  }
  room?.addResponse(user.username, question_number, option);
};

const resetGame = (user: User, ws: WebSocket) => {
  let room: Room | undefined;
  const roomId = users.get(user.username);
  let message: string = "";
  if (!roomId) {
    message = "You are not in a room.";
  } else {
    room = rooms.get(roomId);

    if (!room) {
      message = "Room not found.";
    } else if (user.username !== room.admin_username) {
      message = "Only the room admin can reset the quiz.";
    } else if (room.current_state !== "result") {
      message = "Cannot reset the quiz before results.";
    }
  }
  if (message?.length) {
    const responseString = JSON.stringify({
      success: false,
      type: "reset-quiz",
      message: message,
    });
    ws.send(responseString);
    return;
  }
  room?.resetRoom();
};

const broadcastEventToSingleUser = (data: any, ws: WebSocket) => {
  data = JSON.stringify(data);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
};

server.listen(port, () => {
  console.log(`Server running on port: ${port}`);
});

app.get("/", (_req, res) => {
  res.send("This is a simple ts-express backend");
});

export default app;
