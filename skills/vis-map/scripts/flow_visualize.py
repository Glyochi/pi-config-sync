#!/usr/bin/env python3
"""Validate typed-Markdown runtime flows and render a standalone HTML graph."""

import html
import json
import math
import os
import re
import sys
import tomllib
import zlib
from collections import defaultdict, deque
from pathlib import Path

from flow_runtime import (LINK_COLORS as RUNTIME_LINK_COLORS, clamp_runtime_position,
                          layout_runtime_scenario, refit_runtime_frames)

FORMAT_VERSION = 2
SECTIONS = ("Format", "Flow Entities", "Flow DataTypes", "Scenarios")
ID_PATTERN = re.compile(r"^[a-z][a-z0-9_-]*$")
EVENT_KINDS = {"trigger", "action", "decision", "join", "subflow", "gap", "return"}
LINK_COLORS = ["#2563eb", "#0f766e", "#7c3aed", "#b45309", "#be123c", "#475569", "#047857", "#a21caf"]
COLUMN_GAP = 360
ROW_GAP = 180


class FlowFormatError(ValueError):
    """Source-located flow format or validation error."""


def fail(path, line, section, context, message):
    location = "{}:{} [{}]".format(path, line, section)
    if context:
        location += " {}".format(context)
    raise FlowFormatError("{}: {}".format(location, message))


def sections_from_markdown(text, path):
    lines = text.splitlines()
    headings = {}
    for number, line in enumerate(lines, 1):
        match = re.match(r"^##\s+(.+?)\s*$", line)
        if match and match.group(1) in SECTIONS:
            name = match.group(1)
            if name in headings:
                fail(path, number, name, "", "section appears more than once")
            headings[name] = number
    missing = [name for name in SECTIONS if name not in headings]
    if missing:
        fail(path, 1, "document", "", "missing required section(s): {}".format(", ".join(missing)))

    result = {}
    for name in SECTIONS:
        start = headings[name]
        end = len(lines)
        for number in range(start + 1, len(lines) + 1):
            if re.match(r"^##\s+", lines[number - 1]):
                end = number - 1
                break
        body = lines[start:end]
        fences = []
        opened = None
        for local_number, line in enumerate(body, start + 1):
            if not line.strip().startswith("```"):
                continue
            if opened is None:
                opened = (local_number, line.strip()[3:].strip())
            else:
                fences.append((opened, local_number, body[opened[0] - start:local_number - start - 1]))
                opened = None
        if opened:
            fail(path, opened[0], name, "", "unclosed fenced block")
        blocks = [block for block in fences if block[0][1] == "toml"]
        if len(blocks) != 1:
            fail(path, start, name, "", "expected exactly one ```toml fenced block")
        (fence_line, _), _, contents = blocks[0]
        result[name] = ("\n".join(contents), fence_line + 1)
    return result


def parse_toml_sections(text, path):
    sources = sections_from_markdown(text, path)
    values, locations = {}, {}
    for section, (source, first_line) in sources.items():
        try:
            values[section] = tomllib.loads(source)
        except tomllib.TOMLDecodeError as error:
            line = getattr(error, "lineno", 1) or 1
            column = getattr(error, "colno", None)
            fail(path, first_line + line - 1, section, "", "invalid TOML{}: {}".format(" column {}".format(column) if column else "", error))
        loc = {"root": first_line}
        scenario_number = -1
        counts = defaultdict(int)
        for offset, line in enumerate(source.splitlines()):
            table = re.match(r"^\s*\[\[([a-zA-Z_.]+)\]\]\s*(?:#.*)?$", line)
            if not table:
                continue
            name = table.group(1)
            if name == "scenario":
                scenario_number += 1
                loc[(name, counts[name])] = first_line + offset
                counts[name] += 1
            elif name in ("entity", "datatype"):
                loc[(name, counts[name])] = first_line + offset
                counts[name] += 1
            elif name.startswith("scenario."):
                loc.setdefault(("scenario", scenario_number, name.split(".", 1)[1]), []).append(first_line + offset)
        locations[section] = loc
    return values, locations


def record_line(section_locations, kind, index, scenario_index=None):
    if scenario_index is not None:
        lines = section_locations.get(("scenario", scenario_index, kind), [])
        if index < len(lines):
            return lines[index]
    return section_locations.get((kind, index), section_locations.get("root", 1))


def expect_fields(path, section, context, line, record, allowed):
    if not isinstance(record, dict):
        fail(path, line, section, context, "expected a TOML table")
    extra = sorted(set(record) - set(allowed))
    if extra:
        fail(path, line, section, context, "unknown field(s): {}".format(", ".join(extra)))


def string_field(path, section, context, line, record, key, required=True, default=None):
    if key not in record:
        if required:
            fail(path, line, section, context, "missing required string field {!r}".format(key))
        return default
    value = record[key]
    if not isinstance(value, str) or not value.strip():
        fail(path, line, section, context, "field {!r} must be a non-empty string".format(key))
    return value.strip()


def bool_field(path, section, context, line, record, key, default=None):
    if key not in record:
        if default is None:
            fail(path, line, section, context, "missing required boolean field {!r}".format(key))
        return default
    if type(record[key]) is not bool:
        fail(path, line, section, context, "field {!r} must be a boolean".format(key))
    return record[key]


def table_list(path, section, context, line, record, key, required=False):
    if key not in record:
        if required:
            fail(path, line, section, context, "missing required array {!r}".format(key))
        return []
    value = record[key]
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        fail(path, line, section, context, "field {!r} must be an array of inline tables".format(key))
    return value


def id_field(path, section, context, line, value, kind):
    if not ID_PATTERN.fullmatch(value):
        fail(path, line, section, context, "{} ID {!r} must match [a-z][a-z0-9_-]*".format(kind, value))


def port_records(path, scenario, key, line, context, datatype_ids):
    ports = table_list(path, "Scenarios", context, line, scenario, key)
    output, names = [], set()
    for port in ports:
        expect_fields(path, "Scenarios", context, line, port, {"name", "datatype", "required", "description"})
        name = string_field(path, "Scenarios", context, line, port, "name")
        datatype = string_field(path, "Scenarios", context, line, port, "datatype")
        if name in names:
            fail(path, line, "Scenarios", context, "duplicate {} port {!r}".format(key, name))
        names.add(name)
        if datatype not in datatype_ids:
            fail(path, line, "Scenarios", context, "{} port {!r} references unknown Flow DataType {!r}".format(key, name, datatype))
        output.append({"name": name, "datatype": datatype,
                       "required": bool_field(path, "Scenarios", context, line, port, "required", True),
                       "description": string_field(path, "Scenarios", context, line, port, "description", False, "")})
    return output


def _private_fields_removed(item):
    if isinstance(item, dict):
        return {key: _private_fields_removed(value) for key, value in item.items() if not key.startswith("_")}
    if isinstance(item, list):
        return [_private_fields_removed(value) for value in item]
    return item


def execution_contexts(path, raw, scenario, locations, scenario_index):
    """Parse explicit scenario-local OS processes and their threads (v2 only)."""
    context = "scenario {!r}".format(scenario["id"])
    process_ids, thread_ids, main_threads = set(), set(), set()
    for key in ("processes", "threads"):
        values = table_list(path, "Scenarios", context, scenario["_line"], raw, key)
        scenario[key] = []
        for index, value in enumerate(values):
            line = record_line(locations, key, index, scenario_index)
            item_context = "{} {} #{}".format(context, key, index + 1)
            allowed = {"id", "name", "count", "description"}
            if key == "threads":
                allowed |= {"process", "role", "daemon"}
            expect_fields(path, "Scenarios", item_context, line, value, allowed)
            item_id = string_field(path, "Scenarios", item_context, line, value, "id")
            id_field(path, "Scenarios", item_context, line, item_id, key)
            ids = process_ids if key == "processes" else thread_ids
            if item_id in ids:
                fail(path, line, "Scenarios", item_context, "duplicate {} ID {!r}".format(key, item_id))
            ids.add(item_id)
            count = value.get("count", 1)
            if not ((type(count) is int and count > 0) or (type(count) is str and count in {"0..n", "1..n"})):
                fail(path, line, "Scenarios", item_context, "count must be a positive integer, '0..n', or '1..n'")
            item = {"id": item_id, "name": string_field(path, "Scenarios", item_context, line, value, "name"),
                    "count": count, "description": string_field(path, "Scenarios", item_context, line, value, "description", False, "")}
            if key == "threads":
                process = string_field(path, "Scenarios", item_context, line, value, "process")
                if process not in process_ids:
                    fail(path, line, "Scenarios", item_context, "unknown process reference {!r}".format(process))
                role = string_field(path, "Scenarios", item_context, line, value, "role", False, "background")
                if role not in {"main", "background"}:
                    fail(path, line, "Scenarios", item_context, "thread role must be main or background")
                if role == "main":
                    if count != 1 or process in main_threads:
                        fail(path, line, "Scenarios", item_context, "a process may have at most one modeled main thread, with count=1")
                    main_threads.add(process)
                item.update(process=process, role=role)
                if "daemon" in value:
                    item["daemon"] = bool_field(path, "Scenarios", item_context, line, value, "daemon")
            scenario[key].append(item)
    return thread_ids


def execution_link(path, scenario, link, events):
    source, target = events[link["source"]], events[link["target"]]
    category = link["category"]
    context = "scenario {!r} link {!r}".format(scenario["id"], link["id"])

    def execution_context(event):
        if event.get("thread"):
            return ("thread", event["thread"])
        return ("external", event["participant"])

    if category == "sequence":
        if execution_context(source) != execution_context(target):
            fail(path, link["_line"], "Scenarios", context, "sequence links must stay in one executing thread or external actor; use spawn, message, or signal across contexts")
        if source["kind"] == "terminate":
            fail(path, link["_line"], "Scenarios", context, "termination cannot continue execution")
    elif category == "spawn":
        if not target.get("thread") or target["kind"] != "start" or source.get("thread") == target.get("thread"):
            fail(path, link["_line"], "Scenarios", context, "spawn must target a start event in a different thread")
        if source["kind"] == "terminate":
            fail(path, link["_line"], "Scenarios", context, "a terminated thread cannot spawn another thread")
        if link["loop"]:
            fail(path, link["_line"], "Scenarios", context, "spawn cannot be an execution loop; repeat the creator's sequence instead")
    elif execution_context(source) == execution_context(target):
        fail(path, link["_line"], "Scenarios", context, "message and signal links must cross execution contexts; use sequence within one context")


def parse_flows_text(text, path="FLOWS.md"):
    """Parse and fully validate a version-1 or version-2 FLOWS.md document."""
    sections, locs = parse_toml_sections(text, path)
    format_data, format_line = sections["Format"], locs["Format"]["root"]
    expect_fields(path, "Format", "", format_line, format_data, {"version"})
    version = format_data.get("version")
    if type(version) is not int or version not in {1, FORMAT_VERSION}:
        fail(path, format_line, "Format", "", "version must be integer 1 or 2; unsupported or missing version")

    entity_data = sections["Flow Entities"]
    expect_fields(path, "Flow Entities", "", locs["Flow Entities"]["root"], entity_data, {"entity"})
    raw_entities = entity_data.get("entity", [])
    if not isinstance(raw_entities, list):
        fail(path, locs["Flow Entities"]["root"], "Flow Entities", "", "expected [[entity]] records")
    entities, entity_ids = [], set()
    for index, raw in enumerate(raw_entities):
        line = record_line(locs["Flow Entities"], "entity", index)
        context = "entity #{}".format(index + 1)
        expect_fields(path, "Flow Entities", context, line, raw, {"id", "name", "summary", "code_refs"})
        entity_id = string_field(path, "Flow Entities", context, line, raw, "id")
        id_field(path, "Flow Entities", context, line, entity_id, "entity")
        if entity_id in entity_ids:
            fail(path, line, "Flow Entities", context, "duplicate Flow Entity ID {!r}".format(entity_id))
        entity_ids.add(entity_id)
        code_refs = raw.get("code_refs", [])
        if not isinstance(code_refs, list) or any(not isinstance(value, str) or not value.strip() for value in code_refs):
            fail(path, line, "Flow Entities", context, "code_refs must be an array of non-empty strings")
        entities.append({"id": entity_id, "name": string_field(path, "Flow Entities", context, line, raw, "name"),
                         "summary": string_field(path, "Flow Entities", context, line, raw, "summary"),
                         "code_refs": [value.strip() for value in code_refs]})

    datatype_data = sections["Flow DataTypes"]
    expect_fields(path, "Flow DataTypes", "", locs["Flow DataTypes"]["root"], datatype_data, {"datatype"})
    raw_datatypes = datatype_data.get("datatype", [])
    if not isinstance(raw_datatypes, list):
        fail(path, locs["Flow DataTypes"]["root"], "Flow DataTypes", "", "expected [[datatype]] records")
    datatypes, datatype_ids = [], set()
    for index, raw in enumerate(raw_datatypes):
        line = record_line(locs["Flow DataTypes"], "datatype", index)
        context = "datatype #{}".format(index + 1)
        expect_fields(path, "Flow DataTypes", context, line, raw, {"id", "name", "summary", "fields"})
        datatype_id = string_field(path, "Flow DataTypes", context, line, raw, "id")
        id_field(path, "Flow DataTypes", context, line, datatype_id, "datatype")
        if datatype_id in datatype_ids:
            fail(path, line, "Flow DataTypes", context, "duplicate Flow DataType ID {!r}".format(datatype_id))
        datatype_ids.add(datatype_id)
        raw_fields = table_list(path, "Flow DataTypes", context, line, raw, "fields", required=True)
        fields, field_names = [], set()
        for field in raw_fields:
            expect_fields(path, "Flow DataTypes", context, line, field, {"name", "type", "required", "description"})
            name = string_field(path, "Flow DataTypes", context, line, field, "name")
            if name in field_names:
                fail(path, line, "Flow DataTypes", context, "duplicate shape field {!r}".format(name))
            field_names.add(name)
            fields.append({"name": name, "type": string_field(path, "Flow DataTypes", context, line, field, "type"),
                           "required": bool_field(path, "Flow DataTypes", context, line, field, "required", True),
                           "description": string_field(path, "Flow DataTypes", context, line, field, "description", False, "")})
        datatypes.append({"id": datatype_id, "name": string_field(path, "Flow DataTypes", context, line, raw, "name"),
                          "summary": string_field(path, "Flow DataTypes", context, line, raw, "summary"), "fields": fields})

    scenario_data = sections["Scenarios"]
    expect_fields(path, "Scenarios", "", locs["Scenarios"]["root"], scenario_data, {"scenario"})
    raw_scenarios = scenario_data.get("scenario", [])
    if not isinstance(raw_scenarios, list) or not raw_scenarios:
        fail(path, locs["Scenarios"]["root"], "Scenarios", "", "at least one [[scenario]] record is required")
    scenarios, scenario_ids = [], set()
    scenario_locs = locs["Scenarios"]
    for si, raw in enumerate(raw_scenarios):
        line = record_line(scenario_locs, "scenario", si)
        context = "scenario #{}".format(si + 1)
        expect_fields(path, "Scenarios", context, line, raw, {"id", "title", "description", "entrypoint", "inputs", "outputs", "participants", "events", "links"} | ({"processes", "threads"} if version == 2 else set()))
        scenario_id = string_field(path, "Scenarios", context, line, raw, "id")
        id_field(path, "Scenarios", context, line, scenario_id, "scenario")
        if scenario_id in scenario_ids:
            fail(path, line, "Scenarios", context, "duplicate scenario ID {!r}".format(scenario_id))
        scenario_ids.add(scenario_id)
        context = "scenario {!r}".format(scenario_id)
        scenario = {"id": scenario_id, "title": string_field(path, "Scenarios", context, line, raw, "title"),
                    "description": string_field(path, "Scenarios", context, line, raw, "description", False, ""),
                    "entrypoint": bool_field(path, "Scenarios", context, line, raw, "entrypoint"),
                    "inputs": port_records(path, raw, "inputs", line, context, datatype_ids),
                    "outputs": port_records(path, raw, "outputs", line, context, datatype_ids),
                    "participants": [], "events": [], "links": [], "_line": line}
        thread_ids = execution_contexts(path, raw, scenario, scenario_locs, si) if version == 2 else set()
        all_ports = [port["name"] for port in scenario["inputs"] + scenario["outputs"]]
        if len(all_ports) != len(set(all_ports)):
            fail(path, line, "Scenarios", context, "input and output names must be unique")

        for key in ("participants", "events", "links"):
            values = raw.get(key, [])
            if not isinstance(values, list) or any(not isinstance(value, dict) for value in values):
                fail(path, line, "Scenarios", context, "expected [[scenario.{}]] records".format(key))
        raw_participants, raw_events, raw_links = (raw.get(key, []) for key in ("participants", "events", "links"))
        if not raw_events:
            fail(path, line, "Scenarios", context, "scenario must contain at least one event")

        for pi, participant in enumerate(raw_participants):
            p_line = record_line(scenario_locs, "participants", pi, si)
            p_context = "{} participant #{}".format(context, pi + 1)
            expect_fields(path, "Scenarios", p_context, p_line, participant, {"id", "name", "kind", "entity", "description"})
            pid = string_field(path, "Scenarios", p_context, p_line, participant, "id")
            id_field(path, "Scenarios", p_context, p_line, pid, "participant")
            kind = string_field(path, "Scenarios", p_context, p_line, participant, "kind")
            if kind not in {"runtime", "external"}:
                fail(path, p_line, "Scenarios", p_context, "participant kind must be runtime or external")
            entity = string_field(path, "Scenarios", p_context, p_line, participant, "entity", kind == "runtime", None)
            if kind == "runtime" and entity not in entity_ids:
                fail(path, p_line, "Scenarios", p_context, "unknown Flow Entity reference {!r}".format(entity))
            if kind == "external" and "entity" in participant:
                fail(path, p_line, "Scenarios", p_context, "external actors must not reference a Flow Entity")
            scenario["participants"].append({"id": pid, "name": string_field(path, "Scenarios", p_context, p_line, participant, "name"),
                                             "kind": kind, "entity": entity,
                                             "description": string_field(path, "Scenarios", p_context, p_line, participant, "description", False, ""),
                                             "_line": p_line})
        participant_ids = [item["id"] for item in scenario["participants"]]
        if len(participant_ids) != len(set(participant_ids)):
            duplicate = next(value for i, value in enumerate(participant_ids) if value in participant_ids[:i])
            item = next(value for value in scenario["participants"] if value["id"] == duplicate)
            fail(path, item["_line"], "Scenarios", context, "duplicate participant ID {!r}".format(duplicate))
        participants = {item["id"]: item for item in scenario["participants"]}

        for ei, event in enumerate(raw_events):
            e_line = record_line(scenario_locs, "events", ei, si)
            e_context = "{} event #{}".format(context, ei + 1)
            expect_fields(path, "Scenarios", e_context, e_line, event, {"id", "title", "participant", "kind", "description", "contract", "timing", "delivery", "subflow", "mode", "bindings", "open_question"} | ({"thread"} if version == 2 else set()))
            eid = string_field(path, "Scenarios", e_context, e_line, event, "id")
            id_field(path, "Scenarios", e_context, e_line, eid, "event")
            owner = string_field(path, "Scenarios", e_context, e_line, event, "participant")
            if owner not in participants:
                fail(path, e_line, "Scenarios", e_context, "unknown participant reference {!r}".format(owner))
            kind = string_field(path, "Scenarios", e_context, e_line, event, "kind")
            event_kinds = EVENT_KINDS | ({"start", "terminate"} if version == 2 else set())
            if kind not in event_kinds:
                fail(path, e_line, "Scenarios", e_context, "kind must be one of {}".format(", ".join(sorted(event_kinds))))
            contract = string_field(path, "Scenarios", e_context, e_line, event, "contract", False, None)
            if contract is not None and contract not in datatype_ids:
                fail(path, e_line, "Scenarios", e_context, "unknown Flow DataType reference {!r}".format(contract))
            item = {"id": eid, "title": string_field(path, "Scenarios", e_context, e_line, event, "title"),
                    "participant": owner, "kind": kind,
                    "description": string_field(path, "Scenarios", e_context, e_line, event, "description", False, ""),
                    "contract": contract, "timing": string_field(path, "Scenarios", e_context, e_line, event, "timing", False, ""),
                    "delivery": string_field(path, "Scenarios", e_context, e_line, event, "delivery", False, ""), "_line": e_line}
            if version == 2:
                runtime = participants[owner]["kind"] == "runtime"
                if not runtime and "thread" in event:
                    fail(path, e_line, "Scenarios", e_context, "external events must not reference an application thread")
                if runtime:
                    thread = string_field(path, "Scenarios", e_context, e_line, event, "thread")
                    if thread not in thread_ids:
                        fail(path, e_line, "Scenarios", e_context, "unknown thread reference {!r}".format(thread))
                    item["thread"] = thread
                if kind in {"start", "terminate"} and not runtime:
                    fail(path, e_line, "Scenarios", e_context, "thread start/terminate events must be runtime events")
            if kind == "trigger" and participants[owner]["kind"] != "external":
                fail(path, e_line, "Scenarios", e_context, "trigger events must belong to an external participant")
            if kind == "gap":
                item["open_question"] = string_field(path, "Scenarios", e_context, e_line, event, "open_question")
            elif "open_question" in event:
                fail(path, e_line, "Scenarios", e_context, "open_question is only valid for gap events")
            if kind == "subflow":
                item["subflow"] = string_field(path, "Scenarios", e_context, e_line, event, "subflow")
                item["mode"] = string_field(path, "Scenarios", e_context, e_line, event, "mode")
                if item["mode"] not in {"sync", "async"}:
                    fail(path, e_line, "Scenarios", e_context, "subflow mode must be sync or async")
                item["bindings"] = []
                item["_raw_bindings"] = table_list(path, "Scenarios", e_context, e_line, event, "bindings", required=True)
            elif {"subflow", "mode", "bindings"} & set(event):
                fail(path, e_line, "Scenarios", e_context, "subflow, mode, and bindings are only valid for subflow events")
            scenario["events"].append(item)
        event_ids = [item["id"] for item in scenario["events"]]
        if len(event_ids) != len(set(event_ids)):
            duplicate = next(value for i, value in enumerate(event_ids) if value in event_ids[:i])
            item = next(value for value in scenario["events"] if value["id"] == duplicate)
            fail(path, item["_line"], "Scenarios", context, "duplicate event ID {!r} within scenario".format(duplicate))
        event_by_id = {item["id"]: item for item in scenario["events"]}

        for li, link in enumerate(raw_links):
            l_line = record_line(scenario_locs, "links", li, si)
            l_context = "{} link #{}".format(context, li + 1)
            expect_fields(path, "Scenarios", l_context, l_line, link, {"id", "source", "target", "type", "label", "guard", "loop", "timing", "delivery"} | ({"category"} if version == 2 else set()))
            lid = string_field(path, "Scenarios", l_context, l_line, link, "id")
            id_field(path, "Scenarios", l_context, l_line, lid, "link")
            source = string_field(path, "Scenarios", l_context, l_line, link, "source")
            target = string_field(path, "Scenarios", l_context, l_line, link, "target")
            if source not in event_by_id:
                fail(path, l_line, "Scenarios", l_context, "unknown source event reference {!r}".format(source))
            if target not in event_by_id:
                fail(path, l_line, "Scenarios", l_context, "unknown target event reference {!r}".format(target))
            loop = bool_field(path, "Scenarios", l_context, l_line, link, "loop", False)
            guard = string_field(path, "Scenarios", l_context, l_line, link, "guard", False, "")
            if loop and not guard:
                fail(path, l_line, "Scenarios", l_context, "guarded repeat links require a guard")
            scenario["links"].append({"id": lid, "source": source, "target": target,
                                      "type": string_field(path, "Scenarios", l_context, l_line, link, "type"),
                                      "label": string_field(path, "Scenarios", l_context, l_line, link, "label", False, ""),
                                      "guard": guard, "loop": loop,
                                      "timing": string_field(path, "Scenarios", l_context, l_line, link, "timing", False, ""),
                                      "delivery": string_field(path, "Scenarios", l_context, l_line, link, "delivery", False, ""), "_line": l_line})
            if version == 2:
                category = string_field(path, "Scenarios", l_context, l_line, link, "category")
                if category not in RUNTIME_LINK_COLORS:
                    fail(path, l_line, "Scenarios", l_context, "category must be sequence, spawn, message, or signal")
                parsed_link = scenario["links"][-1]
                parsed_link["category"] = category
                execution_link(path, scenario, parsed_link, event_by_id)
        link_ids = [item["id"] for item in scenario["links"]]
        if len(link_ids) != len(set(link_ids)):
            duplicate = next(value for i, value in enumerate(link_ids) if value in link_ids[:i])
            item = next(value for value in scenario["links"] if value["id"] == duplicate)
            fail(path, item["_line"], "Scenarios", context, "duplicate link ID {!r} within scenario".format(duplicate))

        incoming, outgoing, adjacency = defaultdict(list), defaultdict(list), defaultdict(list)
        indegree = {eid: 0 for eid in event_ids}
        for link in scenario["links"]:
            incoming[link["target"]].append(link)
            outgoing[link["source"]].append(link)
            if not link["loop"]:
                adjacency[link["source"]].append(link["target"])
                indegree[link["target"]] += 1
        thread_events = defaultdict(list)
        for event in scenario["events"]:
            if event.get("thread"):
                thread_events[event["thread"]].append(event)
            if event["kind"] == "terminate" and outgoing[event["id"]]:
                fail(path, event["_line"], "Scenarios", "event {!r}".format(event["id"]), "a thread termination event cannot have outgoing links")
            if event["kind"] == "start":
                incoming_start = incoming[event["id"]]
                if any(link.get("category") != "spawn" for link in incoming_start):
                    fail(path, event["_line"], "Scenarios", "event {!r}".format(event["id"]), "thread entry can only be reached by a spawn link")
            branches = [link for link in outgoing[event["id"]] if not link["loop"]]
            if event["kind"] == "decision":
                guards = [link["guard"] for link in branches]
                if len(branches) < 2 or any(not value for value in guards) or len(guards) != len(set(guards)):
                    fail(path, event["_line"], "Scenarios", "event {!r}".format(event["id"]), "decision needs at least two distinct, guarded outgoing branches")
            if event["kind"] == "join" and len([link for link in incoming[event["id"]] if not link["loop"]]) < 2:
                fail(path, event["_line"], "Scenarios", "event {!r}".format(event["id"]), "join needs at least two incoming non-loop links")
        for thread_id, events_in_thread in thread_events.items():
            starts = [event for event in events_in_thread if event["kind"] == "start"]
            if len(starts) != 1:
                event = events_in_thread[0]
                fail(path, event["_line"], "Scenarios", "thread {!r}".format(thread_id), "a thread with expanded events must have exactly one start event")
        ready = deque(event["id"] for event in scenario["events"] if indegree[event["id"]] == 0)
        visited = 0
        while ready:
            current = ready.popleft()
            visited += 1
            for target in adjacency[current]:
                indegree[target] -= 1
                if indegree[target] == 0:
                    ready.append(target)
        if visited != len(event_ids):
            cycle = next(event for event in scenario["events"] if indegree[event["id"]] > 0)
            fail(path, cycle["_line"], "Scenarios", context, "causal cycle must be an intentional loop=true edge with a guard")
        scenario["_event_map"] = event_by_id
        scenario["_ports"] = {"inputs": {port["name"]: port for port in scenario["inputs"]},
                               "outputs": {port["name"]: port for port in scenario["outputs"]}}
        scenarios.append(scenario)

    scenario_by_id = {scenario["id"]: scenario for scenario in scenarios}
    invoked = set()
    for caller in scenarios:
        for event in caller["events"]:
            if event["kind"] != "subflow":
                continue
            context = "scenario {!r} event {!r}".format(caller["id"], event["id"])
            child_id = event["subflow"]
            if child_id not in scenario_by_id:
                fail(path, event["_line"], "Scenarios", context, "unknown subflow scenario reference {!r}".format(child_id))
            invoked.add(child_id)
            child = scenario_by_id[child_id]
            seen = set()
            for binding_index, binding in enumerate(event["_raw_bindings"]):
                b_context = "{} binding #{}".format(context, binding_index + 1)
                expect_fields(path, "Scenarios", b_context, event["_line"], binding, {"direction", "source", "target", "datatype"})
                direction = string_field(path, "Scenarios", b_context, event["_line"], binding, "direction")
                source = string_field(path, "Scenarios", b_context, event["_line"], binding, "source")
                target = string_field(path, "Scenarios", b_context, event["_line"], binding, "target")
                datatype = string_field(path, "Scenarios", b_context, event["_line"], binding, "datatype")
                if direction == "in":
                    sources = caller["_ports"]["inputs"] | caller["_ports"]["outputs"]
                    targets = child["_ports"]["inputs"]
                elif direction == "out":
                    sources, targets = child["_ports"]["outputs"], caller["_ports"]["outputs"]
                else:
                    fail(path, event["_line"], "Scenarios", b_context, "binding direction must be in or out")
                if source not in sources:
                    fail(path, event["_line"], "Scenarios", b_context, "binding source port {!r} does not exist".format(source))
                if target not in targets:
                    fail(path, event["_line"], "Scenarios", b_context, "binding target port {!r} does not exist".format(target))
                if sources[source]["datatype"] != datatype or targets[target]["datatype"] != datatype:
                    fail(path, event["_line"], "Scenarios", b_context, "binding datatype must match both source and target contracts")
                if datatype not in datatype_ids:
                    fail(path, event["_line"], "Scenarios", b_context, "unknown Flow DataType reference {!r}".format(datatype))
                if (direction, target) in seen:
                    fail(path, event["_line"], "Scenarios", b_context, "binding target {!r} is mapped more than once".format(target))
                seen.add((direction, target))
                event["bindings"].append({"direction": direction, "source": source, "target": target, "datatype": datatype})
            missing = [port["name"] for port in child["inputs"] if port["required"] and ("in", port["name"]) not in seen]
            if missing:
                fail(path, event["_line"], "Scenarios", context, "missing required child input binding(s): {}".format(", ".join(missing)))
            del event["_raw_bindings"]
    for scenario in scenarios:
        if not scenario["entrypoint"] and scenario["id"] not in invoked:
            fail(path, scenario["_line"], "Scenarios", "scenario {!r}".format(scenario["id"]), "unreferenced scenario must set entrypoint = true")
    return _private_fields_removed({"version": version, "entities": entities, "datatypes": datatypes, "scenarios": scenarios})


def parse_flows_file(path):
    try:
        with open(path, encoding="utf-8") as source:
            return parse_flows_text(source.read(), path)
    except OSError as error:
        raise FlowFormatError("{}: cannot read flow source: {}".format(path, error)) from error


def layout_scenario(scenario):
    events = scenario["events"]
    indegree = {event["id"]: 0 for event in events}
    adjacency = defaultdict(list)
    for link in scenario["links"]:
        if not link["loop"]:
            adjacency[link["source"]].append(link["target"])
            indegree[link["target"]] += 1
    depth = {event["id"]: 0 for event in events}
    queue = deque(event["id"] for event in events if indegree[event["id"]] == 0)
    while queue:
        current = queue.popleft()
        for target in adjacency[current]:
            depth[target] = max(depth[target], depth[current] + 1)
            indegree[target] -= 1
            if not indegree[target]:
                queue.append(target)
    columns = defaultdict(list)
    for event in events:
        columns[depth[event["id"]]].append(event["id"])
    positions = {}
    for column, ids in columns.items():
        for row, event_id in enumerate(ids):
            positions[event_id] = {"x": 150 + column * COLUMN_GAP, "y": 152 + row * ROW_GAP}
    width = 360 + max(columns, default=0) * COLUMN_GAP
    height = 190 + max((len(ids) for ids in columns.values()), default=1) * ROW_GAP
    return {"positions": positions, "width": width, "height": height}


def render_model(flow, saved_layout=None):
    model = json.loads(json.dumps(flow))
    saved_layout = saved_layout or {}
    entities = {item["id"]: item for item in model["entities"]}
    datatypes = {item["id"]: item for item in model["datatypes"]}
    scenarios = {item["id"]: item for item in model["scenarios"]}
    for scenario in model["scenarios"]:
        scenario["layout"] = layout_runtime_scenario(scenario) if model["version"] == 2 else layout_scenario(scenario)
        for participant in scenario["participants"]:
            participant["key"] = scenario["id"] + "::" + participant["id"]
            participant["scenario_title"] = scenario["title"]
        stored = saved_layout.get(scenario["id"], {})
        for event_id, position in stored.items():
            if event_id in scenario["layout"]["positions"]:
                applied = clamp_runtime_position(scenario, scenario["layout"], event_id, position) if model["version"] == 2 else dict(position)
                if applied != position:
                    print("Warning: clamped saved flow position to its declared execution lane: {}/{}.".format(scenario["id"], event_id), file=sys.stderr)
                scenario["layout"]["positions"][event_id] = applied
        if model["version"] == 2:
            refit_runtime_frames(scenario, scenario["layout"])
        positions = scenario["layout"]["positions"]
        scenario["layout"]["width"] = max(scenario["layout"]["width"], max((p["x"] + 180 for p in positions.values()), default=0))
        scenario["layout"]["height"] = max(scenario["layout"]["height"], max((p["y"] + 120 for p in positions.values()), default=0))
        for participant in scenario["participants"]:
            participant["entity_name"] = entities[participant["entity"]]["name"] if participant["entity"] else None
        for event in scenario["events"]:
            event["contract_name"] = datatypes[event["contract"]]["name"] if event["contract"] else None
            if event["kind"] == "subflow":
                event["subflow_title"] = scenarios[event["subflow"]]["title"]
                for binding in event["bindings"]:
                    binding["datatype_name"] = datatypes[binding["datatype"]]["name"]
        for link in scenario["links"]:
            link["color"] = RUNTIME_LINK_COLORS[link["category"]] if model["version"] == 2 else LINK_COLORS[zlib.crc32(link["type"].encode()) % len(LINK_COLORS)]
        for event in scenario["events"]:
            event["join_input_count"] = sum(1 for link in scenario["links"] if link["target"] == event["id"] and not link["loop"])
    return model


def json_for_script(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


LAYOUT_VERSION = 1
MAX_LAYOUT_COORDINATE = 1_000_000
MIN_LAYOUT_X = 140
MIN_LAYOUT_Y = 130


def layout_path_for_output(output_path):
    stem, _ = os.path.splitext(output_path)
    return stem + ".layout.json"


def _coordinate(value, minimum):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        result = float(value)
    except (OverflowError, ValueError):
        return None
    if not math.isfinite(result) or result < minimum or result > MAX_LAYOUT_COORDINATE:
        return None
    return result


def load_saved_layout(layout_path, flow):
    """Read a versioned flow-only sidecar; stale IDs and invalid coordinates are ignored."""
    try:
        with open(layout_path, encoding="utf-8") as source:
            saved = json.load(source)
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        print("Warning: ignoring flow layout {}: {}".format(layout_path, error), file=sys.stderr)
        return {}
    if (not isinstance(saved, dict) or type(saved.get("version")) is not int
            or saved.get("version") != LAYOUT_VERSION or not isinstance(saved.get("scenarios"), dict)):
        print("Warning: ignoring unsupported or invalid flow layout {}.".format(layout_path), file=sys.stderr)
        return {}

    known = {scenario["id"]: {event["id"] for event in scenario["events"]} for scenario in flow["scenarios"]}
    positions = {}
    for scenario_id, event_map in saved["scenarios"].items():
        if scenario_id not in known or not isinstance(event_map, dict):
            continue
        valid = {}
        for event_id, point in event_map.items():
            if event_id not in known[scenario_id] or not isinstance(point, dict):
                continue
            x, y = _coordinate(point.get("x"), MIN_LAYOUT_X), _coordinate(point.get("y"), MIN_LAYOUT_Y)
            if x is None or y is None:
                print("Warning: ignoring invalid flow layout coordinates for {}/{}.".format(scenario_id, event_id), file=sys.stderr)
                continue
            valid[event_id] = {"x": x, "y": y}
        if valid:
            positions[scenario_id] = valid
    return positions


CSS = r"""
:root { font:14px/1.45 system-ui,sans-serif; color:#1e293b; background:#f8fafc; }
* { box-sizing:border-box } body { margin:0; min-width:780px } button { font:inherit; cursor:pointer; color:inherit }
header { display:flex; align-items:center; gap:16px; padding:12px 18px; background:white; border-bottom:1px solid #cbd5e1 }
header h1 { font-size:18px; margin:0 } .north-star,.note { color:#64748b; font-size:11px }
.navigation { margin-left:auto; display:flex; align-items:center; gap:8px } .navigation button,.scenario-button,.detail-action { padding:5px 9px; border:1px solid #94a3b8; border-radius:4px; background:white }
.navigation button:disabled { opacity:.45; cursor:default } #breadcrumbs { display:flex; gap:5px; align-items:center } #breadcrumbs button { border:0; color:#1d4ed8; background:transparent; text-decoration:underline }
.layout { display:grid; grid-template-columns:220px minmax(420px,1fr) 280px; min-height:calc(100vh - 55px) } aside { padding:12px; background:white; overflow:auto } aside h2 { font-size:14px; margin:0 0 8px }
#scenario-index { border-right:1px solid #cbd5e1 } #details { border-left:1px solid #cbd5e1 } .scenario-button { display:block; width:100%; text-align:left; margin:5px 0; border-color:transparent }
.scenario-button.active { background:#dbeafe; border-color:#60a5fa } .scenario-role { display:block; font-size:11px; color:#64748b }
main { min-width:0; padding:14px } #scenario-summary { padding:0 4px 12px } #scenario-summary h2 { margin:0; font-size:19px } #scenario-summary p { margin:4px 0; color:#475569 }
.graph-shell { width:100%; height:calc(100vh - 150px); min-height:440px; overflow:auto; background:white; border:1px solid #cbd5e1 } #flow-graph { display:block; min-width:100% }
.edge-path { fill:none; stroke-width:2.3; marker-end:url(#flow-arrow) } .edge-path.loop { stroke:#b91c1c!important; stroke-dasharray:8 5 } .edge-hit { fill:none; stroke:transparent; stroke-width:18; cursor:pointer }
.edge-label { font-size:11px; fill:#334155; paint-order:stroke; stroke:white; stroke-width:4px; stroke-linejoin:round; pointer-events:none } .flow-link.selected .edge-path { stroke-width:4 }
.event-node { cursor:pointer; outline:none } .event-node rect { fill:#eff6ff; stroke:#2563eb; stroke-width:2; rx:12 }
.event-node.trigger rect { fill:#ecfdf5; stroke:#047857 } .event-node.decision rect { fill:#fff7ed; stroke:#c2410c } .event-node.join rect { fill:#f5f3ff; stroke:#7c3aed; rx:28 }
.event-node.subflow rect { fill:#eef2ff; stroke:#4f46e5 } .event-node.gap rect { fill:#fff7ed; stroke:#b45309; stroke-dasharray:7 4 } .event-node.return rect { fill:#f1f5f9; stroke:#64748b }
.event-node.selected rect,.event-node:focus rect { stroke:#0f172a; stroke-width:4 } .event-id { fill:#64748b; font-size:10px } .event-title { fill:#0f172a; font-size:13px; font-weight:650 }
.event-owner { fill:#334155; font-size:10px } .event-meta { fill:#475569; font-size:10px } .event-kind { fill:#334155; font-size:9px; font-weight:700; letter-spacing:.04em }
.event-node.participant-dim { opacity:.18 } .event-node.participant-highlight rect:first-child { stroke:#d97706; stroke-width:4 }
.flow-link.participant-dim { opacity:.12 } .flow-link.participant-highlight { opacity:1 }
.participant-instance-badge rect { fill:#fff; stroke:#64748b; stroke-width:1; rx:10 }
.participant-instance-badge text { fill:#334155; font-size:9px; font-weight:600 }
.event-node { cursor:grab; touch-action:none } .event-node:active { cursor:grabbing }
#participant-controls { margin-top:14px; border-top:1px solid #e2e8f0; padding-top:10px }
#participant-controls h3 { font-size:12px; margin:0 0 6px }
#participant-list { max-height:230px; overflow:auto }
.participant-option { display:flex; gap:5px; align-items:flex-start; font-size:11px; padding:3px 0 }
.participant-option input { margin:2px 0 0 }
.participant-modes { display:flex; gap:4px; flex-wrap:wrap; margin:5px 0 }
.participant-modes button,.layout-tools button { font-size:11px; padding:4px 7px; border:1px solid #94a3b8; border-radius:4px; background:#fff }
.participant-modes button.active { background:#dbeafe; border-color:#2563eb }
#clear-participants { margin:4px 0 } .layout-tools { display:flex; align-items:center; gap:8px; margin-left:auto }
#layout-status { max-width:220px; color:#64748b; font-size:10px }
#layout-status.error { color:#b91c1c }
.subflow-button rect { fill:white; stroke:#6366f1; rx:4 } .subflow-button text { fill:#3730a3; font-size:10px } .subflow-button { cursor:pointer }
#details h3 { margin:0 0 8px; font-size:16px } #details h4 { margin:14px 0 4px; font-size:12px } #details p { margin:5px 0; overflow-wrap:anywhere }
#details dl { display:grid; grid-template-columns:85px 1fr; gap:4px; margin:7px 0 } #details dt { color:#64748b } #details dd { margin:0; overflow-wrap:anywhere } #details ul { padding-left:20px; margin:5px 0 }
.detail-action { margin-top:8px; color:#1d4ed8 } .badge { display:inline-block; padding:1px 5px; border:1px solid #94a3b8; border-radius:10px; color:#475569; font-size:10px }
@media(max-width:1050px) { .layout { grid-template-columns:180px minmax(400px,1fr) } #details { grid-column:1/-1; border-left:0; border-top:1px solid #cbd5e1 } }
"""

JS = r"""
(function(){
"use strict";
var model=JSON.parse(document.getElementById("flow-data").textContent), scenarios={}, entities={}, datatypes={};
model.scenarios.forEach(function(x){scenarios[x.id]=x}); model.entities.forEach(function(x){entities[x.id]=x}); model.datatypes.forEach(function(x){datatypes[x.id]=x});
var index=document.getElementById("scenario-index"), graph=document.getElementById("flow-graph"), summary=document.getElementById("scenario-summary"), details=document.getElementById("details"), back=document.getElementById("back-button"), crumbs=document.getElementById("breadcrumbs");
var participantList=document.getElementById("participant-list"), highlightButton=document.getElementById("highlight-mode"), filterButton=document.getElementById("filter-mode"), clearParticipantsButton=document.getElementById("clear-participants"), saveLayoutButton=document.getElementById("save-flow-layout"), layoutStatus=document.getElementById("layout-status");
var layoutInfo=JSON.parse(document.getElementById("layout-info").textContent);
var current=null, history=[], selectedEvent=null, selectedLink=null, participantMode="highlight", selectedParticipants=Object.create(null), dragging=null;
function el(tag,cls,value){var x=document.createElement(tag);if(cls)x.className=cls;if(value!==undefined)x.textContent=String(value);return x}
function svg(tag,attrs){var x=document.createElementNS("http://www.w3.org/2000/svg",tag);Object.keys(attrs||{}).forEach(function(k){x.setAttribute(k,String(attrs[k]))});return x}
function addText(parent,tag,cls,value,attrs){var x=svg(tag,attrs||{});if(cls)x.setAttribute("class",cls);x.textContent=String(value);parent.appendChild(x);return x}
function clear(x){x.replaceChildren()} function row(list,label,value){if(value===undefined||value===null||value==="")return;list.appendChild(el("dt","",label));list.appendChild(el("dd","",value))}
function participantLabel(s,e){var p=s.participants.find(function(x){return x.id===e.participant});return p.kind==="external"?p.name+" · external":p.name+" · "+(p.entity_name||entities[p.entity].name)}
function participantKey(s,e){return s.id+"::"+e.participant}
function hasParticipantSelection(){return Object.keys(selectedParticipants).length>0}
function isParticipantSelected(s,e){return !!selectedParticipants[participantKey(s,e)]}
function eventVisible(s,e){return participantMode!=="filter"||!hasParticipantSelection()||isParticipantSelected(s,e)}
function updateParticipantControls(){clear(participantList);model.scenarios.forEach(function(s){s.participants.forEach(function(p){var label=el("label","participant-option"),box=el("input");box.type="checkbox";box.checked=!!selectedParticipants[p.key];box.setAttribute("data-participant-key",p.key);box.addEventListener("change",function(){if(box.checked)selectedParticipants[p.key]=true;else delete selectedParticipants[p.key];if(current)renderGraph(scenarios[current])});label.appendChild(box);label.appendChild(el("span","",p.name+" — "+s.title+(p.entity_name?" · "+p.entity_name:" · external")));participantList.appendChild(label)})});highlightButton.className=participantMode==="highlight"?"active":"";highlightButton.setAttribute("aria-pressed",participantMode==="highlight");filterButton.className=participantMode==="filter"?"active":"";filterButton.setAttribute("aria-pressed",participantMode==="filter")}
function setParticipantMode(mode){if(mode!=="highlight"&&mode!=="filter")return;participantMode=mode;updateParticipantControls();if(current)renderGraph(scenarios[current])}
function clearParticipantSelection(){selectedParticipants=Object.create(null);participantMode="highlight";updateParticipantControls();if(current)renderGraph(scenarios[current])}
function updateIndex(){clear(index);model.scenarios.forEach(function(s){var b=el("button","scenario-button"+(s.id===current?" active":""));b.type="button";b.appendChild(el("span","",s.title));b.appendChild(el("span","scenario-role",s.entrypoint?"Entrypoint":"Linked subflow"));b.addEventListener("click",function(){navigate(s.id,false)});index.appendChild(b)})}
function updateCrumbs(){clear(crumbs);var chain=history.concat(current?[current]:[]);chain.forEach(function(id,i){if(i)crumbs.appendChild(el("span","","›"));var b=el("button","",scenarios[id].title);if(i===chain.length-1)b.setAttribute("aria-current","page");b.addEventListener("click",function(){history=chain.slice(0,i);render(id)});crumbs.appendChild(b)});back.disabled=history.length===0}
function edgePath(a,b,loop){var x1=a.x+130,y1=a.y,x2=b.x-130,y2=b.y;if(loop)return "M "+x1+" "+y1+" C "+(x1+75)+" "+(y1-115)+", "+(x2-75)+" "+(y2-115)+", "+x2+" "+y2;var mid=(x1+x2)/2;return "M "+x1+" "+y1+" C "+mid+" "+y1+", "+mid+" "+y2+", "+x2+" "+y2}
function fitLayout(s){var points=Object.keys(s.layout.positions).map(function(id){return s.layout.positions[id]});s.layout.width=Math.max(s.layout.width,Math.max.apply(null,points.map(function(p){return p.x+180})));s.layout.height=Math.max(s.layout.height,Math.max.apply(null,points.map(function(p){return p.y+120})))}
function graphPoint(evt,s){var rect=graph.getBoundingClientRect(),w=Number(graph.getAttribute("width"))||s.layout.width,h=Number(graph.getAttribute("height"))||s.layout.height;return {x:(evt.clientX-rect.left)*(s.layout.width/(rect.width||w)),y:(evt.clientY-rect.top)*(s.layout.height/(rect.height||h))}}
function beginDrag(evt,eventId){if(evt.button!==undefined&&evt.button!==0)return;var s=scenarios[current],p=s.layout.positions[eventId],point=graphPoint(evt,s);dragging={scenarioId:current,eventId:eventId,dx:p.x-point.x,dy:p.y-point.y,moved:false}}
function moveDrag(evt){if(!dragging)return;var s=scenarios[dragging.scenarioId],point=graphPoint(evt,s),x=Math.max(140,Math.min(1000000,point.x+dragging.dx)),y=Math.max(130,Math.min(1000000,point.y+dragging.dy));if(Math.abs(x-s.layout.positions[dragging.eventId].x)<1&&Math.abs(y-s.layout.positions[dragging.eventId].y)<1)return;s.layout.positions[dragging.eventId]={x:x,y:y};dragging.moved=true;fitLayout(s);renderGraph(s)}
function endDrag(){dragging=null}
function wrap(value,max){var words=String(value).split(/\s+/),lines=[""];words.forEach(function(word){var i=lines.length-1,next=lines[i]?lines[i]+" "+word:word;if(next.length>32&&lines[i]&&lines.length<2)lines.push(word);else lines[i]=next});if(lines.length===2&&lines[1].length>32)lines[1]=lines[1].slice(0,31)+"…";return lines}
function renderGraph(s){clear(graph);var layout=s.layout;graph.setAttribute("viewBox","0 0 "+layout.width+" "+layout.height);graph.setAttribute("width",layout.width);graph.setAttribute("height",layout.height);
var defs=svg("defs"),marker=svg("marker",{id:"flow-arrow",markerWidth:8,markerHeight:8,refX:7,refY:4,orient:"auto"});marker.appendChild(svg("path",{d:"M0,0 L8,4 L0,8 z",fill:"context-stroke"}));defs.appendChild(marker);graph.appendChild(defs);var pos=layout.positions;
s.links.forEach(function(l){var source=s.events.find(function(e){return e.id===l.source}),target=s.events.find(function(e){return e.id===l.target}),sourceSelected=isParticipantSelected(s,source),targetSelected=isParticipantSelected(s,target),classes="flow-link"+(l.id===selectedLink?" selected":"");if(hasParticipantSelection()&&participantMode==="highlight")classes+=(sourceSelected||targetSelected?" participant-highlight":" participant-dim");var g=svg("g",{"class":classes,"data-link-id":l.id,tabindex:0,role:"button","aria-label":l.type+" link"}),d=edgePath(pos[l.source],pos[l.target],l.loop);if(!eventVisible(s,source)||!eventVisible(s,target))g.setAttribute("display","none");g.appendChild(svg("path",{"class":"edge-hit",d:d}));g.appendChild(svg("path",{"class":"edge-path"+(l.loop?" loop":""),d:d,stroke:l.color}));var label=l.type+(l.label?" · "+l.label:"")+(l.guard?" · "+l.guard:"");addText(g,"text","edge-label",label,{x:(pos[l.source].x+pos[l.target].x)/2,y:(pos[l.source].y+pos[l.target].y)/2-(l.loop?54:7),"text-anchor":"middle"});g.addEventListener("click",function(){selectLink(l.id)});g.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();selectLink(l.id)}});graph.appendChild(g)});
s.events.forEach(function(e){var p=pos[e.id],key=participantKey(s,e),selected=isParticipantSelected(s,e),classes="event-node "+e.kind+(e.id===selectedEvent?" selected":"");if(hasParticipantSelection()&&participantMode==="highlight")classes+=(selected?" participant-highlight":" participant-dim");var g=svg("g",{"class":classes,"data-event-id":e.id,"data-participant-key":key,tabindex:0,role:"button","aria-label":e.title+", "+participantLabel(s,e)});if(!eventVisible(s,e))g.setAttribute("display","none");g.appendChild(svg("rect",{x:p.x-130,y:p.y-76,width:260,height:152}));addText(g,"text","event-id",e.id,{x:p.x-116,y:p.y-55});var k=e.kind==="gap"?"UNKNOWN GAP":e.kind.toUpperCase();if(e.kind==="subflow")k+=" · "+e.mode.toUpperCase();addText(g,"text","event-kind",k,{x:p.x+116,y:p.y-55,"text-anchor":"end"});wrap(e.title).forEach(function(line,i){addText(g,"text","event-title",line,{x:p.x-116,y:p.y-29+i*17})});var owner=participantLabel(s,e),badge=svg("g",{"class":"participant-instance-badge","data-participant-key":key});badge.appendChild(svg("rect",{x:p.x-116,y:p.y+2,width:Math.min(232,Math.max(90,owner.length*5.5+18)),height:21}));addText(badge,"text","event-owner",owner.length>39?owner.slice(0,38)+"…":owner,{x:p.x-106,y:p.y+16});g.appendChild(badge);var meta=e.kind==="gap"?"Unexplored behavior":(e.contract_name?"Shape: "+e.contract_name:(e.timing||e.delivery||""));addText(g,"text","event-meta",meta.length>38?meta.slice(0,37)+"…":meta,{x:p.x-116,y:p.y+38});g.addEventListener("click",function(){selectEvent(e.id)});g.addEventListener("pointerdown",function(evt){beginDrag(evt,e.id)});g.addEventListener("keydown",function(kb){if(kb.key==="Enter"||kb.key===" "){kb.preventDefault();selectEvent(e.id)}});graph.appendChild(g);
if(e.kind==="subflow"&&eventVisible(s,e)){var child=scenarios[e.subflow],b=svg("g",{"class":"subflow-button","data-subflow-target":e.subflow,tabindex:0,role:"button","aria-label":"Open subflow "+child.title});b.appendChild(svg("rect",{x:p.x-102,y:p.y+47,width:204,height:22}));var label="Open: "+child.title;addText(b,"text","",label.length>28?label.slice(0,27)+"…":label,{x:p.x,y:p.y+62,"text-anchor":"middle"});b.addEventListener("click",function(evt){evt.stopPropagation();openSubflow(e.id)});b.addEventListener("keydown",function(kb){if(kb.key==="Enter"||kb.key===" "){kb.preventDefault();kb.stopPropagation();openSubflow(e.id)}});graph.appendChild(b)}})}
function render(id){if(!scenarios[id])return;current=id;selectedEvent=selectedLink=null;var s=scenarios[id];clear(summary);summary.appendChild(el("h2","",s.title));summary.appendChild(el("p","",s.description));summary.appendChild(el("span","badge",s.entrypoint?"Entrypoint":"Linked subflow"));renderGraph(s);updateIndex();updateParticipantControls();updateCrumbs();clear(details);details.appendChild(el("p","note","Select an event or typed link. This is intended guidance, not an observed execution trace."))}
function navigate(id,push){if(!scenarios[id])return;if(push&&current)history.push(current);else if(!push)history=[];render(id)}
function openSubflow(eventId){var s=scenarios[current],e=s.events.find(function(x){return x.id===eventId});if(e&&e.kind==="subflow")navigate(e.subflow,true)}
function goBack(){if(history.length)render(history.pop())}
function selectEvent(id){var s=scenarios[current],e=s.events.find(function(x){return x.id===id});if(!e)return;selectedEvent=id;selectedLink=null;renderGraph(s);clear(details);details.appendChild(el("h3","",e.title));details.appendChild(el("span","badge",e.kind==="gap"?"Unknown gap":e.kind));if(e.description)details.appendChild(el("p","",e.description));var p=s.participants.find(function(x){return x.id===e.participant}),dl=el("dl");row(dl,"Participant",participantLabel(s,e));row(dl,"Event ID",e.id);row(dl,"Timing",e.timing);row(dl,"Delivery",e.delivery);if(p.description)row(dl,"Role",p.description);details.appendChild(dl);
if(e.contract){var d=datatypes[e.contract];details.appendChild(el("h4","","Flow DataType shape · "+d.name));details.appendChild(el("p","",d.summary));var ul=el("ul");d.fields.forEach(function(f){ul.appendChild(el("li","",f.name+": "+f.type+(f.required?" (required)":" (optional)")))});details.appendChild(ul);details.appendChild(el("p","note","Contracts describe shape; timing and delivery belong to events and links."))}
if(e.kind==="gap")details.appendChild(el("p","","Open question: "+e.open_question));if(e.kind==="join")details.appendChild(el("p","","Explicit join after "+e.join_input_count+" incoming causal links."));if(e.kind==="decision"){var branches=s.links.filter(function(l){return l.source===e.id&&!l.loop});if(branches.length){details.appendChild(el("h4","","Guarded branches"));var bl=el("ul");branches.forEach(function(l){bl.appendChild(el("li","",l.guard+" · "+l.type))});details.appendChild(bl)}}
if(e.kind==="subflow"){var child=scenarios[e.subflow];details.appendChild(el("h4","","Invokes "+child.title+" · "+(e.mode==="sync"?"sync (awaited)":"async")));if(e.bindings.length){var list=el("ul");e.bindings.forEach(function(b){list.appendChild(el("li","",b.direction+": "+b.source+" → "+b.target+" · "+b.datatype_name))});details.appendChild(list)}var open=el("button","detail-action","Open subflow: "+child.title);open.addEventListener("click",function(){openSubflow(e.id)});details.appendChild(open)}
if(p.entity){var entity=entities[p.entity];details.appendChild(el("h4","","Flow Entity · "+entity.name));details.appendChild(el("p","",entity.summary));if(entity.code_refs.length)details.appendChild(el("p","note","Code navigation hints (not verification): "+entity.code_refs.join(", ")))}}
function selectLink(id){var s=scenarios[current],l=s.links.find(function(x){return x.id===id});if(!l)return;selectedLink=id;selectedEvent=null;renderGraph(s);clear(details);details.appendChild(el("h3","",l.type+" link"));var source=s.events.find(function(x){return x.id===l.source}),target=s.events.find(function(x){return x.id===l.target}),dl=el("dl");row(dl,"From",source.title+" · "+participantLabel(s,source));row(dl,"To",target.title+" · "+participantLabel(s,target));row(dl,"Type",l.type);row(dl,"Label",l.label);row(dl,"Guard",l.guard);row(dl,"Repeat",l.loop?"Guarded repeat":"No");row(dl,"Timing",l.timing);row(dl,"Delivery",l.delivery);details.appendChild(dl)}
function saveLayout(){var data={version:layoutInfo.version,scenarios:{}};model.scenarios.forEach(function(s){data.scenarios[s.id]={};s.events.forEach(function(e){var p=s.layout.positions[e.id];if(p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=140&&p.x<=1000000&&p.y>=130&&p.y<=1000000)data.scenarios[s.id][e.id]={x:p.x,y:p.y}})});var blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=layoutInfo.filename;document.body.appendChild(link);link.click();link.remove();setTimeout(function(){URL.revokeObjectURL(url)},1000);layoutStatus.textContent="Downloaded "+layoutInfo.filename+". Place it beside the HTML before regenerating.";layoutStatus.className=""}
highlightButton.addEventListener("click",function(){setParticipantMode("highlight")});filterButton.addEventListener("click",function(){setParticipantMode("filter")});clearParticipantsButton.addEventListener("click",clearParticipantSelection);saveLayoutButton.addEventListener("click",saveLayout);
window.addEventListener("pointermove",moveDrag);window.addEventListener("pointerup",endDrag);window.addEventListener("pointercancel",endDrag);
back.addEventListener("click",goBack);var root=model.scenarios.find(function(x){return x.entrypoint});render(root?root.id:model.scenarios[0].id);
window.flowGraphApp={navigateTo:navigate,openSubflow:openSubflow,goBack:goBack,selectEvent:selectEvent,selectLink:selectLink,setParticipantMode:setParticipantMode,clearParticipantSelection:clearParticipantSelection,get currentScenario(){return current},get breadcrumbs(){return history.concat(current?[current]:[])},get positions(){return scenarios[current].layout.positions}};
})();
"""


def render_flow_html(flow, source_name="FLOWS.md", layout_filename="flow-graph.layout.json", saved_layout=None):
    model = render_model(flow, saved_layout)
    source = html.escape(os.path.basename(source_name))
    runtime = flow["version"] == 2
    script_dir = Path(__file__).resolve().parent
    style = CSS + (script_dir.joinpath("flow_runtime.css").read_text(encoding="utf-8") if runtime else "")
    script = script_dir.joinpath("flow_runtime.js").read_text(encoding="utf-8") if runtime else JS
    sidebar = '''<section id="participant-controls"><h3>Participant instances</h3><div class="participant-modes"><button id="highlight-mode" type="button" aria-pressed="true">Highlight</button><button id="filter-mode" type="button" aria-pressed="false">Filter</button></div><div id="participant-list"></div><button id="clear-participants" type="button">Clear selection</button><p class="note">Selections apply across scenarios.</p></section>'''
    runtime_legend = ""
    body_class = "runtime-view" if runtime else ""
    graph_label = "Process and thread frames with top-to-bottom execution paths" if runtime else "Left-to-right causal event graph"
    return """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Intended runtime flows</title><style>{css}</style></head>
<body class="{body_class}"><header><h1>Intended runtime flows</h1><span class="north-star">{source} · selective guidance, not an execution trace</span><div class="navigation"><button id="back-button" type="button" disabled>← Back</button><nav id="breadcrumbs" aria-label="Scenario breadcrumbs"></nav></div><div class="layout-tools"><button id="save-flow-layout" type="button">Save flow layout</button><span id="layout-status" aria-live="polite"></span></div></header>
<div class="layout"><aside><h2>Scenarios</h2><div id="scenario-index"></div>{sidebar}</aside><main><section id="scenario-summary"></section>{runtime_legend}<div class="graph-shell"><svg id="flow-graph" role="img" aria-label="{graph_label}"></svg></div></main><aside id="details" aria-live="polite"><p class="note">Select an event or typed link for details.</p></aside></div>
<script type="application/json" id="flow-data">{data}</script><script type="application/json" id="layout-info">{layout_info}</script><script>{script}</script></body></html>""".format(css=style, source=source, body_class=body_class, sidebar=sidebar, runtime_legend=runtime_legend, graph_label=graph_label, data=json_for_script(model), layout_info=json_for_script({"version": LAYOUT_VERSION, "filename": os.path.basename(layout_filename)}), script=script)


def render_flow_file(input_path="map/FLOWS.md", output_path="map/flow-graph.html"):
    """Validate completely, then atomically replace the flow HTML."""
    flow = parse_flows_file(input_path)
    layout_path = layout_path_for_output(output_path)
    saved_layout = load_saved_layout(layout_path, flow)
    page = render_flow_html(flow, input_path, layout_path, saved_layout)
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    temporary = output_path + ".tmp"
    try:
        with open(temporary, "w", encoding="utf-8") as output:
            output.write(page)
        os.replace(temporary, output_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("Wrote {} ({} scenarios, {} Flow Entities, {} Flow DataTypes)".format(output_path, len(flow["scenarios"]), len(flow["entities"]), len(flow["datatypes"])))


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if args and args[0] in {"-h", "--help"}:
        print("Usage: flow_visualize.py [map/FLOWS.md [map/flow-graph.html]]")
        return 0
    if len(args) > 2:
        print("Usage: flow_visualize.py [map/FLOWS.md [map/flow-graph.html]]", file=sys.stderr)
        return 2
    try:
        render_flow_file(args[0] if args else "map/FLOWS.md", args[1] if len(args) > 1 else "map/flow-graph.html")
    except FlowFormatError as error:
        print("Error: {}".format(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
