"""Versioned table/field allow-list; agents cannot choose arbitrary URLs."""
from dataclasses import dataclass


@dataclass(frozen=True)
class TableSpec:
    key: str
    fields: tuple[str, ...]
    required: bool = False


def spec(key, fields, required=False):
    return TableSpec(key, tuple(dict.fromkeys(("sys_id", "sys_updated_on", *fields.split(",")))), required)


TABLES = {
    "cmdb_ci": spec("cis", "name,sys_class_name,serial_number,fqdn,ip_address,owned_by,managed_by,support_group,operational_status,install_status,discovery_source,last_discovered,business_criticality", True),
    "cmdb_rel_ci": spec("relationships", "parent,child,type,type.name", True),
    "cmdb_ci_service": spec("services", "name,sys_class_name,owned_by,operational_status,life_cycle_stage,life_cycle_stage_status"),
    "service_offering": spec("offerings", "name,parent,owned_by"),
    "ecc_agent": spec("mid_servers", "name,status,validated,last_refreshed"),
    "ecc_queue": spec("ecc_queue", "name,state,queue,agent,sys_created_on"),
    "em_alert": spec("alerts", "number,cmdb_ci,state,severity,source"),
    "incident": spec("incidents", "number,cmdb_ci,priority,state,active,sys_created_on,resolved_at,reopen_count"),
    "change_request": spec("changes", "number,cmdb_ci,priority,state,active,type,close_code"),
    "problem": spec("problems", "number,cmdb_ci,priority,state,active"),
    "sys_script": spec("business_rules", "name,collection,active,when,condition,filter_condition,script,sys_scope"),
    "sys_rest_message": spec("integrations", "name,rest_endpoint,sys_scope"),
    "sys_trigger": spec("jobs", "name,state,next_action,sys_created_on"),
    "sys_upgrade_history_log": spec("upgrade_logs", "name,disposition,resolution_status,upgrade_history"),
    "sys_user_has_role": spec("user_roles", "user,user.active,role,role.name,inherited"),
}
