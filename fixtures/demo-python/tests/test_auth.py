from pkg.auth import SessionStore, create_session


def test_create_session_valid():
    assert create_session("abc") == "abc"


def test_create_session_expired():
    assert create_session("abc", expired=True) is None


def test_store_put():
    store = SessionStore()
    store.put("u1", "s1")
