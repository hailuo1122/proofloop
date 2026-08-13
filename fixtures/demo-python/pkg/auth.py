from typing import Optional


def create_session(token: str, expired: bool = False) -> Optional[str]:
    """Demo PR head: expired tokens must not create sessions."""
    if expired:
        return None
    return token


class SessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, str] = {}

    def put(self, user_id: str, session: str) -> None:
        self._sessions[user_id] = session
