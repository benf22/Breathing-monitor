"""Unit tests for the lip aspect-ratio math (no webcam / no mediapipe)."""

from __future__ import annotations

import math

import pytest

from breathing_monitor.core.lips import lip_metrics, mouth_aspect_ratio


def make_landmarks(opening: float, width: float = 0.2, n: int = 478):
    """Synthetic landmark list with a controllable mouth opening and width.

    Vertical inner-lip pairs are placed ``opening`` apart; the mouth corners
    are placed ``width`` apart horizontally. Everything else is a filler point.
    """
    pts = [(0.0, 0.0, 0.0)] * n
    cx, cy = 0.5, 0.5
    for upper, lower in ((13, 14), (81, 178), (311, 402)):
        pts[upper] = (cx, cy, 0.0)
        pts[lower] = (cx, cy + opening, 0.0)
    pts[78] = (cx - width / 2, cy, 0.0)   # left inner corner
    pts[308] = (cx + width / 2, cy, 0.0)  # right inner corner
    return pts


def test_mar_matches_expected_ratio():
    mar, vertical, horizontal = mouth_aspect_ratio(make_landmarks(0.1, width=0.2))
    assert math.isclose(vertical, 0.1, abs_tol=1e-6)
    assert math.isclose(horizontal, 0.2, abs_tol=1e-6)
    assert math.isclose(mar, 0.5, abs_tol=1e-6)


def test_closed_mouth_below_threshold():
    m = lip_metrics(make_landmarks(0.02), open_threshold=0.35)
    assert m.mar < 0.35
    assert m.is_open is False


def test_open_mouth_above_threshold():
    m = lip_metrics(make_landmarks(0.12), open_threshold=0.35)
    assert m.mar >= 0.35
    assert m.is_open is True


def test_aspect_ratio_scales_horizontal():
    # A wider frame (aspect > 1) stretches x, increasing the measured width and
    # thus lowering the MAR for the same opening.
    base = mouth_aspect_ratio(make_landmarks(0.1), aspect_ratio=1.0)[0]
    wide = mouth_aspect_ratio(make_landmarks(0.1), aspect_ratio=2.0)[0]
    assert wide < base


def test_zero_width_mouth_is_safe():
    pts = make_landmarks(0.1)
    pts[78] = (0.5, 0.5, 0.0)
    pts[308] = (0.5, 0.5, 0.0)  # zero horizontal width
    mar, _, horizontal = mouth_aspect_ratio(pts)
    assert horizontal == pytest.approx(0.0)
    assert mar == 0.0  # guarded, no ZeroDivisionError


def test_too_few_landmarks_raises():
    with pytest.raises(ValueError):
        mouth_aspect_ratio([(0.0, 0.0, 0.0)] * 10)
