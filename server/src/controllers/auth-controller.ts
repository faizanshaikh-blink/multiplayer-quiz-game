import { z } from "zod";
import { User } from "..";
import { db } from "../db";
import bcrypt from "bcrypt";
import { JwtPayload } from "jsonwebtoken";
import { Request, Response } from "express";
import { asyncHandler } from "../utils/async-handler";
import { createTokens, verifyToken } from "../utils/jwt";

const authSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(4, { message: "Username must be of at least 4 characters." })
    .max(8, { message: "Username can be of atmost 8 characters." }),
  password: z.string().trim().min(8, {
    message: "Password must be of at least 8 characters.",
  }),
});

const accessTokenCookieExpiry = parseInt(
  process.env.ACCESS_TOKEN_COOKIE_EXPIRY!
);

const refreshTokenCookieExpiry = parseInt(
  process.env.REFRESH_TOKEN_COOKIE_EXPIRY!
);

function setCookie(
  res: Response,
  cookieName: string,
  cookieValue: string,
  cookieExpiry: number
) {
  res.cookie(cookieName, cookieValue, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: cookieExpiry,
    secure: process.env.NODE_ENV === "production",
    path: cookieName === "refresh_token" ? "/api/auth" : "/",
  });
}

export const signUp = asyncHandler(async (req: Request, res: Response) => {
  try {
    const { error, success, data } = authSchema.safeParse(req.body);
    if (!success) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    let { username, password } = data;

    const userExists = await db.user.findUnique({
      where: { username },
      select: { id: true },
    });

    if (userExists) {
      return res.status(400).json({ message: "Username already taken!" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await db.user.create({
      data: {
        username: username,
        password: hashedPassword,
      },
      select: {
        id: true,
        username: true,
      },
    });

    const { accessToken, refreshToken } = createTokens(newUser.id, username);

    await db.user.update({
      where: { id: newUser.id },
      data: { refreshToken },
    });

    setCookie(res, "access_token", accessToken, accessTokenCookieExpiry);
    setCookie(res, "refresh_token", refreshToken, refreshTokenCookieExpiry);

    return res
      .status(201)
      .json({ data: { username: newUser.username }, message: "Sign Up successful" });
  } catch (error) {
    console.error("Error in signUp ", error);
    return res
      .status(500)
      .json({ message: "Could not SignUp. Please try again!" });
  }
});

export const signIn = asyncHandler(async (req: Request, res: Response) => {
  try {
    const { error, success, data } = authSchema.safeParse(req.body);
    if (!success) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    let { username, password } = data;

    const user = await db.user.findUnique({
      where: { username },
      select: { id: true, username: true, password: true },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found!" });
    }

    const isPasswordCorrect = await bcrypt.compare(password, user.password);

    if (!isPasswordCorrect) {
      return res.status(400).json({ message: "Incorrect Password!" });
    }

    const { accessToken, refreshToken } = createTokens(user.id, username);

    await db.user.update({
      where: { id: user.id },
      data: { refreshToken },
    });

    setCookie(res, "access_token", accessToken, accessTokenCookieExpiry);
    setCookie(res, "refresh_token", refreshToken, refreshTokenCookieExpiry);

    return res
      .status(200)
      .json({ data: { username: user.username }, message: "Sign In successful" });
  } catch (error) {
    console.error("Error in signIn ", error);
    return res
      .status(500)
      .json({ message: "Could not SignIn. Please try again!" });
  }
});

export const refreshToken = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      const refresh_token = req?.cookies?.refresh_token;

      if (!refresh_token) {
        return res.status(400).json({ message: "Login required!" });
      }

      let decodedToken;
      try {
        decodedToken = verifyToken(
          refresh_token,
          process.env.REFRESH_TOKEN_SECRET!
        ) as JwtPayload;
      } catch (error) {
        return res.status(400).json({ message: "Login required!" });
      }

      const user = await db.user.findUnique({
        where: { id: decodedToken.userId },
        select: {
          id: true,
          username: true,
          refreshToken: true,
        },
      });

      if (!user || user.refreshToken !== refresh_token) {
        return res.status(400).json({ message: "Login required!" });
      }

      const { accessToken, refreshToken: newRefreshToken } = createTokens(
        user.id,
        user.username
      );

      await db.user.update({
        where: { id: user.id },
        data: { refreshToken: newRefreshToken },
      });

      setCookie(res, "access_token", accessToken, accessTokenCookieExpiry);
      setCookie(res, "refresh_token", newRefreshToken, refreshTokenCookieExpiry);

      return res.status(200).json({
        data: { username: user.username },
        message: "Token refresh successful",
      });
    } catch (error) {
      console.error("Error in refreshToken ", error);
      return res.status(500).json({ message: "Could not Refresh Token." });
    }
  }
);

export const logout = asyncHandler(async (req: Request, res: Response) => {
  try {
    const refresh_token = req?.cookies?.refresh_token;

    if (!refresh_token) {
      return res.status(400).json({ message: "Already logged out" });
    }

    const userDetails = req.user as User;

    const user = await db.user.findUnique({
      where: { id: userDetails?.id },
      select: { id: true },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found!" });
    }

    await db.user.update({
      where: { id: user.id },
      data: { refreshToken: null },
    });

    setCookie(res, "access_token", "", 0);
    setCookie(res, "refresh_token", "", 0);

    return res.status(200).json({ message: "Logout successful!" });
  } catch (error) {
    console.error("Error in logout ", error);
    return res.status(500).json({ message: "Could not log out." });
  }
});

export const authCheck = asyncHandler(async (req: Request, res: Response) => {
  return res.status(200).json({ data: req.user, message: "Logged in!" });
});
