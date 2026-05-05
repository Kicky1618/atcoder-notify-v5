import fs from 'fs/promises';
import path from 'path';

export enum PasswordValidation {
    TooShort = 'Password must be at least 8 characters long.',
    TooLong = 'Password must be at most 100 characters long.',
    Blacklisted = 'Password is blacklisted.',
    Valid = 'Password is valid.',
}
export async function isValidPassword(password: string): Promise<PasswordValidation> {
    if (password.length < 8) {
        return PasswordValidation.TooShort;
    }
    if (password.length > 100) {
        return PasswordValidation.TooLong;
    }

    const blacklistedPassword = await fs.readFile(
        path.join(__dirname, '../statics/blacklistedPassword.txt'),
        'utf-8',
    );
    const blacklistedPasswords = blacklistedPassword.split('\n').map((line) => line.trim().toLowerCase());
    if (blacklistedPasswords.includes(password.toLowerCase())) {
        return PasswordValidation.Blacklisted;
    }
    return PasswordValidation.Valid;
}
export enum UsernameValidation {
    TooShort = 'Username must be at least 3 characters long.',
    TooLong = 'Username must be at most 20 characters long.',
    InvalidCharacters = 'Username contains invalid characters.',
    Blacklisted = 'Username is blacklisted.',
    Valid = 'Username is valid.',
}
export async function isValidUsername(username: string): Promise<UsernameValidation> {
    if (username.length < 3) {
        return UsernameValidation.TooShort;
    }
    if (username.length > 20) {
        return UsernameValidation.TooLong;
    }
    const invalidChars = /[^a-zA-Z0-9_]/;
    if (invalidChars.test(username)) {
        return UsernameValidation.InvalidCharacters;
    }
    const blacklistedUsernames = await fs.readFile(
        path.join(__dirname, '../statics/blacklistedUsername.txt'),
        'utf-8',
    );
    const blacklistedUsernamesList = blacklistedUsernames.split('\n').map((line) => line.trim().toLowerCase());
    if (blacklistedUsernamesList.includes(username.toLowerCase())) {
        return UsernameValidation.Blacklisted;
    }
    return UsernameValidation.Valid;
}
export async function isValidTurnstileResponse(turnstileResponse: string): Promise<boolean> {
    if (!turnstileResponse) {
        return false;
    }
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            secret: process.env.TURNSTILE_SECRET || '',
            response: turnstileResponse,
        }),
    });
    const data = await response.json();
    return data.success === true;
}
