"""Regression test for the TS130F stale-idle-position guard.

The TS130F firmware keeps `current_position_lift_percentage` (0x0008) as a
writable NVRAM register rather than a live read-out: ZCL reads and the periodic
report that ZHA configures (max interval 900 s) both answer with whatever was
last written to it, while real movement arrives as unsolicited reports. The
quirk therefore drops idle position updates that contradict the known position
and writes the true position back into the device.

The repo has no Python test framework and does not ship zigpy/zhaquirks, so the
few upstream names the quirk needs are stubbed before importing it. Run with:

    python3 tests/ts130f_position_guard_test.py
"""

from __future__ import annotations

import asyncio
import enum
import importlib.util
import pathlib
import sys
import types

REPO = pathlib.Path(__file__).resolve().parent.parent
QUIRK = (
    REPO
    / "custom_components"
    / "zha_tuya_quirks"
    / "quirks"
    / "tuya_ts130f_ol1uhvza.py"
)

FAILURES: list[str] = []


# ── minimal stubs for the upstream packages the quirk imports ───────────────


class _AttrDef:
    def __init__(self, attr_id: int, name: str) -> None:
        self.id = attr_id
        self.name = name


class _WindowCoveringAttributeDefs:
    current_position_lift_percentage = _AttrDef(
        0x0008, "current_position_lift_percentage"
    )


class _WindowCovering:
    cluster_id = 0x0102
    AttributeDefs = _WindowCoveringAttributeDefs


class _TuyaAttributeDefs(_WindowCoveringAttributeDefs):
    motor_mode = _AttrDef(0x8000, "motor_mode")
    tuya_moving_state = _AttrDef(0xF000, "tuya_moving_state")
    calibration = _AttrDef(0xF001, "calibration")
    motor_reversal = _AttrDef(0xF002, "motor_reversal")
    calibration_time = _AttrDef(0xF003, "calibration_time")


class _TuyaCoveringCluster:
    """Stands in for zhaquirks' cluster, including its 0x0008 inversion."""

    AttributeDefs = _TuyaAttributeDefs

    def __init__(self, *args, **kwargs) -> None:
        self._attr_cache: dict[int, int] = {}
        self.endpoint = types.SimpleNamespace(
            device=types.SimpleNamespace(ieee="a4:c1:38:22:8d:de:27:6c")
        )
        self.written: list[dict[int, int]] = []

    def _update_attribute(self, attrid: int, value) -> None:
        if attrid == 0x0008:
            value = 100 - value
        self._attr_cache[attrid] = value

    async def write_attributes(self, attributes, **kwargs):
        self.written.append(dict(attributes))
        for attrid, value in attributes.items():
            self._update_attribute(attrid, value)
        return [None]

    async def command(self, command_id, *args, **kwargs):
        return [command_id, 0]


class _Enum8(enum.IntEnum):
    pass


class _ChainStub:
    """Swallows the whole QuirkBuilder chain."""

    def __init__(self, *args, **kwargs) -> None:
        pass

    def __getattr__(self, _name):
        return self

    def __call__(self, *args, **kwargs):
        return self


def _install_stubs() -> None:
    zigpy = types.ModuleType("zigpy")
    zigpy_types = types.ModuleType("zigpy.types")
    zigpy_types.enum8 = _Enum8
    zcl = types.ModuleType("zigpy.zcl")
    clusters = types.ModuleType("zigpy.zcl.clusters")
    closures = types.ModuleType("zigpy.zcl.clusters.closures")
    closures.WindowCovering = _WindowCovering

    zhaquirks = types.ModuleType("zhaquirks")
    zhaquirks_tuya = types.ModuleType("zhaquirks.tuya")
    ts130f = types.ModuleType("zhaquirks.tuya.ts130f")
    ts130f.TuyaCoveringCluster = _TuyaCoveringCluster
    builder = types.ModuleType("zhaquirks.builder")
    builder.QuirkBuilder = _ChainStub
    builder.EntityPlatform = _ChainStub()
    builder.EntityType = _ChainStub()
    builder.NumberDeviceClass = _ChainStub()

    for name, module in {
        "zigpy": zigpy,
        "zigpy.types": zigpy_types,
        "zigpy.zcl": zcl,
        "zigpy.zcl.clusters": clusters,
        "zigpy.zcl.clusters.closures": closures,
        "zhaquirks": zhaquirks,
        "zhaquirks.tuya": zhaquirks_tuya,
        "zhaquirks.tuya.ts130f": ts130f,
        "zhaquirks.builder": builder,
    }.items():
        sys.modules[name] = module


class FakeClock:
    """Replaces the quirk module's `time`, so tests control the clock."""

    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _load_quirk():
    _install_stubs()
    spec = importlib.util.spec_from_file_location("ts130f_quirk_under_test", QUIRK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ── helpers ────────────────────────────────────────────────────────────────


def check(label: str, actual, expected) -> None:
    if actual == expected:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}: expected {expected!r}, got {actual!r}")
        FAILURES.append(label)


def ha_position(cluster) -> int | None:
    """What Home Assistant would show: 100 - <cached, already inverted>."""
    cached = cluster._attr_cache.get(0x0008)
    return None if cached is None else 100 - cached


def report_position(cluster, raw: int) -> None:
    cluster._update_attribute(0x0008, raw)


def report_moving(cluster, state: int) -> None:
    cluster._update_attribute(0xF000, state)


# ── tests ──────────────────────────────────────────────────────────────────


def test_stale_idle_report_is_ignored(mod, clock) -> None:
    print("\nstale idle report is ignored")
    cluster = mod.PositionGuardCoveringCluster()

    # A real travel down to fully closed, announced by the moving state.
    report_moving(cluster, mod.MovingState.Down)
    for raw in (19, 15, 8, 1):
        clock.advance(1)
        report_position(cluster, raw)
    clock.advance(1)
    report_moving(cluster, mod.MovingState.Stop)
    report_position(cluster, 0)
    check("position after the travel", ha_position(cluster), 0)

    # 15 minutes later the device volunteers its stale register value.
    clock.advance(900)
    report_position(cluster, 21)
    check("stale 21% report dropped", ha_position(cluster), 0)

    # And keeps volunteering it.
    for _ in range(3):
        clock.advance(900)
        report_position(cluster, 21)
    check("still holding the real position", ha_position(cluster), 0)


def test_settling_report_after_stop_is_kept(mod, clock) -> None:
    print("\nthe settling report just after Stop is kept")
    cluster = mod.PositionGuardCoveringCluster()
    report_moving(cluster, mod.MovingState.Up)
    clock.advance(1)
    report_position(cluster, 40)
    clock.advance(5)
    report_moving(cluster, mod.MovingState.Stop)
    clock.advance(0.05)  # device reports its final position just after Stop
    report_position(cluster, 55)
    check("final position accepted", ha_position(cluster), 55)


def test_first_ever_report_is_kept(mod, clock) -> None:
    print("\na freshly paired device is believed")
    cluster = mod.PositionGuardCoveringCluster()
    report_position(cluster, 33)
    check("first report accepted", ha_position(cluster), 33)


def test_matching_idle_report_is_harmless(mod, clock) -> None:
    print("\nan idle report that agrees is harmless")
    cluster = mod.PositionGuardCoveringCluster()
    report_position(cluster, 70)
    clock.advance(900)
    report_position(cluster, 70)
    check("position unchanged", ha_position(cluster), 70)


def test_unannounced_movement_is_picked_up(mod, clock) -> None:
    print("\nmovement with no moving-state report is picked up")
    cluster = mod.PositionGuardCoveringCluster()
    report_position(cluster, 50)
    clock.advance(900)

    # Wall-switch travel, with the moving state never arriving.
    report_position(cluster, 46)  # first sample: indistinguishable from stale
    check("first sample held back", ha_position(cluster), 50)
    clock.advance(1)
    report_position(cluster, 42)
    check("second differing sample believed", ha_position(cluster), 42)
    clock.advance(1)
    report_position(cluster, 38)
    check("travel keeps being followed", ha_position(cluster), 38)


def test_startup_read_does_not_poison(mod, clock) -> None:
    print("\nthe read-on-startup does not poison a restored position")
    cluster = mod.PositionGuardCoveringCluster()
    # zigpy restores the attribute cache from its database before ZHA reads.
    cluster._attr_cache[0x0008] = 100  # i.e. HA position 0, fully closed
    clock.advance(0.5)  # ZHA reads very early in the process' life
    report_position(cluster, 21)
    check("stale startup read dropped", ha_position(cluster), 0)


def test_write_back_after_travel(mod, clock) -> None:
    print("\nthe true position is written back into the device")
    cluster = mod.PositionGuardCoveringCluster()

    async def run():
        report_moving(cluster, mod.MovingState.Down)
        clock.advance(1)
        report_position(cluster, 35)
        clock.advance(1)
        report_moving(cluster, mod.MovingState.Stop)
        await asyncio.sleep(0.05)  # let the scheduled write-back run

    mod._WRITE_BACK_DELAY_S = 0.0
    asyncio.run(run())
    check("wrote the position back once", len(cluster.written), 1)
    check(
        "wrote the device-scale value",
        cluster.written[0] if cluster.written else None,
        {0x0008: 35},
    )
    check("position unchanged by the write-back", ha_position(cluster), 35)


def test_write_back_is_rate_limited_when_idle(mod, clock) -> None:
    print("\nstale reports trigger at most one write-back per 5 minutes")
    cluster = mod.PositionGuardCoveringCluster()

    async def run():
        report_position(cluster, 0)
        for _ in range(4):
            clock.advance(60)
            report_position(cluster, 21)
            await asyncio.sleep(0.02)

    mod._WRITE_BACK_DELAY_S = 0.0
    asyncio.run(run())
    check("rate limited to one write-back", len(cluster.written), 1)
    check("position held", ha_position(cluster), 0)


def test_lift_command_makes_following_reports_trusted(mod, clock) -> None:
    print("\na lift command we send makes the next reports trusted")

    class _CommandDef:
        id = 0x05  # go_to_lift_percentage, as a definition object

    async def run():
        cluster = mod.PositionGuardCoveringCluster()
        report_position(cluster, 80)
        clock.advance(900)
        await cluster.command(_CommandDef())
        clock.advance(0.5)
        # No moving-state report yet, but we know a travel was just commanded.
        report_position(cluster, 76)
        check("first report after the command believed", ha_position(cluster), 76)

        # A bare command id works the same way.
        cluster2 = mod.PositionGuardCoveringCluster()
        report_position(cluster2, 80)
        clock.advance(900)
        await cluster2.command(0x01)
        clock.advance(0.5)
        report_position(cluster2, 76)
        check("bare command id believed too", ha_position(cluster2), 76)

    mod._WRITE_BACK_DELAY_S = 0.0
    asyncio.run(run())


def main() -> int:
    mod = _load_quirk()
    for test in (
        test_stale_idle_report_is_ignored,
        test_settling_report_after_stop_is_kept,
        test_first_ever_report_is_kept,
        test_matching_idle_report_is_harmless,
        test_unannounced_movement_is_picked_up,
        test_startup_read_does_not_poison,
        test_write_back_after_travel,
        test_write_back_is_rate_limited_when_idle,
        test_lift_command_makes_following_reports_trusted,
    ):
        clock = FakeClock()
        mod.time = clock
        test(mod, clock)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failing check(s): {', '.join(FAILURES)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
