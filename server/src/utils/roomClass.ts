import { WebSocket } from "ws";
import { rooms } from "../index";

interface Question {
  question_number: number;
  text: string;
  options: object;
  answer: string;
}

interface RoomUser {
  username: string;
  score: number;
  ws: WebSocket;
  is_admin: boolean;
}

interface Response {
  answer: string;
  time_left: number;
}

type GameState = "waiting" | "quiz" | "result";

const QUESTION_DURATION: number = 20;

class Room {
  id: string;
  admin_username: string;
  time_left: number;
  current_state: GameState;
  current_question_index: number;
  users: Map<string, RoomUser>;
  allowedUsernames: Map<string, number>;
  questions: Question[];
  responses: Map<string, Response>;
  timeout_id: NodeJS.Timeout | null;
  interval_id: NodeJS.Timeout | undefined;

  constructor(id: string, admin_id: string) {
    this.id = id;
    this.questions = [];
    this.users = new Map();
    this.responses = new Map();
    this.interval_id = undefined;
    this.admin_username = admin_id;
    this.current_state = "waiting";
    this.current_question_index = 0;
    this.allowedUsernames = new Map();
    this.time_left = QUESTION_DURATION;
    this.timeout_id = this.createRoomDeletionTimeout();
  }

  addUser(user: RoomUser): boolean {
    let message: string = "";
    if (this.users.has(user.username))
      message = "You have already joined this room!";
    else if (
      this.current_state !== "waiting" &&
      !this.allowedUsernames.has(user.username)
    )
      message =
        "Cannot join room once the quiz has started. Wait for it to restart or join any other room!";
    if (message?.length) {
      user.ws.send(
        JSON.stringify({
          type: "joined",
          success: false,
          message,
        })
      );
      return false;
    }

    if (this.timeout_id) {
      clearTimeout(this.timeout_id);
      this.timeout_id = null;
    }

    user.score = this.allowedUsernames.get(user.username) || 0;
    this.users.set(user.username, user);

    const roomUsers = this.getRoomUsers();

    const responseString = JSON.stringify({
      success: true,
      type: "joined",
      message: `${user.username} joined the room!`,
      users: roomUsers,
    });

    if (this.current_state !== "result")
      this.broadcastEventToEveryone(responseString);

    this.broadcastCurrentStateDetails(user);

    return true;
  }

  removeUser(username: string, ws: WebSocket) {
    const user = this.users.get(username);
    if (user && user.ws === ws) {
      this.users.delete(username);
    } else return false;
    const roomUsers = this.getRoomUsers();

    if (roomUsers.length === 0)
      this.timeout_id = this.createRoomDeletionTimeout();

    if (this.current_state === "result") return true;

    const responseString = JSON.stringify({
      success: true,
      type: "left",
      message: `${username} left the room!`,
      users: roomUsers,
    });

    this.broadcastEventToEveryone(responseString);
    return true;
  }

  setQuestions(questions: Question[], username: string) {
    this.questions = questions;
    this.checkQuestionsAvailability(username);
  }

  checkQuestionsAvailability(username: string) {
    const user = this.users.get(username);
    let responseString: string;
    if (!user?.is_admin) {
      responseString = JSON.stringify({
        success: false,
        type: "questions",
        message: "Only admin can check questions availability!",
      });
    } else {
      responseString = JSON.stringify({
        success: true,
        type: "questions",
        message: "Questions generated!",
        questionsAvailable: this.questions.length === 10,
      });
    }
    user?.ws.send(responseString);
  }

  startQuiz() {
    this.current_state = "quiz";
    this.allowedUsernames = new Map(
      this.getRoomUsers().map((user) => [user.username, 0])
    );
    this.broadcastQuestion();

    this.interval_id = setInterval(() => {
      this.time_left -= 1;
      if (this.time_left === 0) {
        if (this.current_question_index === this.questions.length - 1) {
          clearInterval(this.interval_id);
          this.showResult();
          return;
        } else {
          this.time_left = QUESTION_DURATION;
          this.current_question_index += 1;
          this.broadcastQuestion();
          return;
        }
      } else this.broadcastTimer();
    }, 1000);

    return;
  }

  broadcastQuestion() {
    const question = this.questions[this.current_question_index];
    this.broadcastEventToEveryone(
      JSON.stringify({
        type: "question",
        time_left: 20,
        question_number: this.current_question_index + 1,
        question_text: question.text,
        question_options: question.options,
      })
    );
    return;
  }

  broadcastTimer() {
    this.broadcastEventToEveryone(
      JSON.stringify({
        type: "timer",
        time_left: this.time_left,
      })
    );
  }

  broadcastCurrentStateDetails(user: RoomUser) {
    const state = this.current_state;
    if (state === "waiting") {
      user.ws.send(
        JSON.stringify({
          type: "current-quiz-details",
          success: true,
          state: "waiting",
        })
      );
    } else if (state === "quiz") {
      const question = this.questions[this.current_question_index];
      const user_response = this.responses.get(
        `${user.username}-${question.question_number}`
      );
      user.ws.send(
        JSON.stringify({
          type: "current-quiz-details",
          success: true,
          state: "quiz",
          time_left: this.time_left,
          question: {
            question_number: question.question_number,
            text: question.text,
            options: question.options,
          },
          has_responded: user_response ? true : false,
          ...(user_response
            ? {
                user_answer: user_response.answer,
                correct_answer: question.answer,
              }
            : {}),
        })
      );
    } else {
      user.ws.send(
        JSON.stringify({
          type: "current-quiz-details",
          success: true,
          state: "result",
          users: Array.from(this.allowedUsernames, ([username, score]) => ({
            username,
            score,
            is_admin: username === this.admin_username,
          })),
        })
      );
    }
  }

  addResponse(username: string, question_number: number, answer: string) {
    const time_left = this.time_left;
    const id = `${username}-${question_number}`;
    const user = this.users.get(username);
    if (this.responses.get(id)) {
      user?.ws?.send(
        JSON.stringify({
          type: "response",
          success: false,
          message: "You have already responded to this question!",
        })
      );
      return;
    } else {
      const current_question = this.questions[question_number - 1];
      if (!current_question) {
        user?.ws?.send(
          JSON.stringify({
            type: "response",
            success: false,
            message: "Invalid question number!",
          })
        );
        return;
      }
      this.responses.set(id, { answer, time_left });
      let score: number;
      if (
        question_number !== this.current_question_index + 1 ||
        current_question.answer !== answer
      )
        score = 0;
      else score = Math.ceil(time_left / 2);
      if (user) {
        user.score += score;
        this.allowedUsernames.set(username, user.score);
        user.ws.send(
          JSON.stringify({
            type: "response",
            success: true,
            question_number,
            message: "Added the response",
            correct_answer: current_question.answer,
          })
        );
        return;
      }
    }
  }

  showResult() {
    this.current_state = "result";
    this.broadcastEventToEveryone(
      JSON.stringify({
        type: "leaderboards",
        success: true,
        message: "Quiz completed!",
        users: this.getRoomUsers(true).sort(
          (a, b) => (b.score ? b.score : 0) - (a.score ? a.score : 0)
        ),
      })
    );
  }

  getRoomUsers(includeScore: boolean = false) {
    return Array.from(this.users.values()).map((user) => {
      const userToSend: {
        username: string;
        is_admin: boolean;
        score?: number;
      } = {
        username: user.username,
        is_admin: user.is_admin,
      };
      if (includeScore) userToSend.score = user.score;
      return userToSend;
    });
  }

  broadcastEventToEveryone(responseString: string) {
    for (const [, roomUser] of this.users) {
      if (roomUser.ws.readyState === WebSocket.OPEN) {
        roomUser.ws.send(responseString);
      }
    }
  }

  resetRoom() {
    if (this.interval_id) clearInterval(this.interval_id);
    this.questions = [];
    this.responses = new Map();
    this.interval_id = undefined;
    this.current_state = "waiting";
    this.current_question_index = 0;
    this.allowedUsernames = new Map();
    this.time_left = QUESTION_DURATION;
    this.users.forEach((user) => (user.score = 0));
    this.broadcastEventToEveryone(
      JSON.stringify({
        type: "reset-quiz",
        success: true,
        users: this.getRoomUsers(),
      })
    );
  }

  createRoomDeletionTimeout() {
    return setTimeout(() => this.deleteRoom(), 120000);
  }

  deleteRoom() {
    const roomUsers = this.getRoomUsers();
    if (roomUsers?.length === 0) {
      if (this.interval_id) clearInterval(this.interval_id);
      this.timeout_id = null;
      rooms.delete(this.id);
    }
  }
}

export default Room;
