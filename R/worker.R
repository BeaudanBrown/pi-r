suppressPackageStartupMessages(library(jsonlite))

summary_script <- Sys.getenv("PI_R_VALUE_SUMMARY_SCRIPT", unset = "")
if (!nzchar(summary_script) || !file.exists(summary_script)) stop("PI_R_VALUE_SUMMARY_SCRIPT is unavailable")
source(summary_script, local = TRUE)

.pi_r_globals <- new.env(parent = globalenv())
.pi_r_session <- new.env(parent = .pi_r_globals)
.pi_r_metadata <- new.env(parent = emptyenv())
.pi_r_loaded_targets <- character()
.pi_r_project_root <- getwd()
.pi_r_sequence <- 0L

clone_value <- function(value) unserialize(serialize(value, NULL))

clone_bindings <- function(source, parent) {
  destination <- new.env(parent = parent)
  for (name in ls(source, all.names = TRUE)) {
    assign(name, clone_value(get(name, envir = source, inherits = FALSE)), envir = destination)
  }
  destination
}

clear_environment <- function(environment) {
  names <- ls(environment, all.names = TRUE)
  if (length(names)) rm(list = names, envir = environment)
}

object_inventory <- function() {
  session_names <- ls(.pi_r_session, all.names = TRUE)
  global_names <- ls(.pi_r_globals, all.names = TRUE)
  names <- sort(unique(c(session_names, global_names)))
  inventory_truncated <- length(names) > 200L
  if (inventory_truncated) names <- names[seq_len(200L)]
  lapply(names, function(name) {
    origin <- if (exists(name, envir = .pi_r_session, inherits = FALSE)) {
      "temporary"
    } else if (name %in% .pi_r_loaded_targets) {
      "target"
    } else {
      "global"
    }
    environment <- if (origin == "temporary") .pi_r_session else .pi_r_globals
    value <- get(name, envir = environment, inherits = FALSE)
    metadata <- if (exists(name, envir = .pi_r_metadata, inherits = FALSE)) {
      get(name, envir = .pi_r_metadata, inherits = FALSE)
    } else NULL
    list(
      name = substr(name, 1L, 200L),
      bytes = length(serialize(value, NULL)),
      class = as.list(substr(head(class(value), 8L), 1L, 200L)),
      origin = origin,
      createdByCall = metadata$createdByCall %||% NULL,
      lastModifiedByCall = metadata$lastModifiedByCall %||% NULL
    )
  })
}

build_context <- function(target_names) {
  setwd(.pi_r_project_root)
  context <- new.env(parent = globalenv())
  if (identical(Sys.getenv("PI_R_WORKER_ENVIRONMENT"), "project") && file.exists("pi-r.yml")) {
    contract <- fromJSON("pi-r.yml", simplifyVector = TRUE)
    for (package in contract$dependencies) {
      suppressPackageStartupMessages(library(package, character.only = TRUE))
    }
  }
  if (dir.exists("R")) {
    source_files <- sort(list.files("R", pattern = "[.]R$", full.names = TRUE))
    for (source_file in source_files) sys.source(source_file, envir = context)
  }
  if (file.exists("_targets.R") && requireNamespace("targets", quietly = TRUE)) {
    sys.source("_targets.R", envir = context)
  }
  if (exists("PI_R_CONSTANTS", envir = context, inherits = FALSE)) {
    list2env(get("PI_R_CONSTANTS", envir = context), envir = context)
  }
  for (name in target_names) {
    if (!grepl("^[A-Za-z.][A-Za-z0-9._]*$", name) || grepl("^\\.[0-9]", name)) stop("Invalid canonical target name: ", name)
    assign(name, targets::tar_read_raw(name), envir = context)
  }
  context
}

commit_context <- function(context, target_names) {
  .pi_r_globals <<- context
  parent.env(.pi_r_session) <- .pi_r_globals
  .pi_r_loaded_targets <<- target_names
}

state_difference <- function(before_names, staged, retain) {
  staged_names <- ls(staged, all.names = TRUE)
  created <- setdiff(staged_names, before_names)
  modified <- intersect(staged_names, before_names)[vapply(intersect(staged_names, before_names), function(name) {
    !identical(get(name, envir = staged, inherits = FALSE), get(name, envir = .pi_r_session, inherits = FALSE))
  }, logical(1))]
  list(
    committed = intersect(retain, staged_names),
    discarded = sort(unique(c(setdiff(created, retain), setdiff(modified, retain)))),
    rolledBack = FALSE
  )
}

handle_evaluate <- function(request) {
  conditions <- new.env(parent = emptyenv())
  conditions$warnings <- character()
  conditions$messages <- character()
  conditions$error <- NULL
  value <- NULL
  result_summary <- NULL
  before_names <- ls(.pi_r_session, all.names = TRUE)
  retain <- unique(unlist(request$retain %||% character(), use.names = FALSE))
  state_delta <- list(committed = list(), discarded = list(), rolledBack = FALSE)
  staged <- NULL
  context <- NULL
  tryCatch(
    withCallingHandlers({
      expressions <- parse(text = request$code, keep.source = FALSE)
      context <- build_context(unlist(request$targets %||% character(), use.names = FALSE))
      staged <- clone_bindings(.pi_r_session, context)
      for (expression in expressions) value <- eval(expression, envir = staged)
      missing_retained <- setdiff(retain, ls(staged, all.names = TRUE))
      if (length(missing_retained)) stop("Requested retained objects were not created: ", paste(missing_retained, collapse = ", "))
      result_summary <- pi_r_value_summary(value)
      state_delta <- state_difference(before_names, staged, retain)
      for (name in retain) {
        existed <- exists(name, envir = .pi_r_session, inherits = FALSE)
        assign(name, clone_value(get(name, envir = staged, inherits = FALSE)), envir = .pi_r_session)
        assign(name, list(
          createdByCall = if (existed && exists(name, envir = .pi_r_metadata, inherits = FALSE)) {
            get(name, envir = .pi_r_metadata, inherits = FALSE)$createdByCall
          } else request$id,
          lastModifiedByCall = request$id
        ), envir = .pi_r_metadata)
      }
      commit_context(context, unlist(request$targets %||% character(), use.names = FALSE))
    }, warning = function(condition) {
      conditions$warnings <- c(conditions$warnings, conditionMessage(condition))
      invokeRestart("muffleWarning")
    }, message = function(condition) {
      conditions$messages <- c(conditions$messages, conditionMessage(condition))
      invokeRestart("muffleMessage")
    }),
    error = function(condition) {
      staged_names <- if (is.null(staged)) character() else ls(staged, all.names = TRUE)
      state_delta <<- list(
        committed = list(),
        discarded = as.list(sort(setdiff(staged_names, before_names))),
        rolledBack = TRUE
      )
      conditions$error <- list(
        code = if (grepl("unexpected|parse", conditionMessage(condition), ignore.case = TRUE)) "R_PARSE_ERROR" else "R_EVALUATION_ERROR",
        message = substr(conditionMessage(condition), 1L, 2000L),
        recoverable = TRUE,
        recovery = c("Revise the expression or requested target names", "Use r_worker_status to inspect committed objects")
      )
    }
  )
  list(
    value = if (is.null(conditions$error) && is.atomic(value) && length(value) <= 100L && length(serialize(value, NULL)) <= 4096L) value else NULL,
    result = if (is.null(conditions$error)) result_summary else NULL,
    stateDelta = state_delta,
    warnings = unname(substr(conditions$warnings[seq_len(min(length(conditions$warnings), 50L))], 1L, 1000L)),
    messages = unname(substr(conditions$messages[seq_len(min(length(conditions$messages), 50L))], 1L, 1000L)),
    error = conditions$error,
    objects = object_inventory()
  )
}

handle_inspect <- function(request) {
  name <- request$name
  environment <- if (exists(name, envir = .pi_r_session, inherits = FALSE)) {
    .pi_r_session
  } else if (exists(name, envir = .pi_r_globals, inherits = FALSE)) {
    .pi_r_globals
  } else NULL
  if (is.null(environment)) {
    return(list(
      name = name,
      summary = NULL,
      error = list(code = "UNKNOWN_WORKER_OBJECT", message = paste("Worker object does not exist:", name), recoverable = TRUE),
      objects = object_inventory()
    ))
  }
  value <- get(name, envir = environment, inherits = FALSE)
  list(
    name = name,
    summary = pi_r_value_summary(
      value,
      columns = unlist(request$columns %||% character(), use.names = FALSE),
      column_offset = request$columnOffset %||% 0L,
      column_limit = request$columnLimit %||% 20L
    ),
    error = NULL,
    objects = object_inventory()
  )
}

handle_workspace <- function(request) {
  conditions <- new.env(parent = emptyenv())
  conditions$error <- NULL
  before <- ls(.pi_r_session, all.names = TRUE)
  context <- NULL
  staged <- NULL
  tryCatch({
    context <- build_context(character())
    staged <- clone_bindings(.pi_r_session, context)
    workspace_call <- as.call(list(
      targets::tar_workspace,
      as.name(request$target),
      envir = staged,
      packages = FALSE,
      source = FALSE
    ))
    eval(workspace_call)
    loaded <- setdiff(ls(staged, all.names = TRUE), before)
    for (name in loaded) {
      assign(name, clone_value(get(name, envir = staged, inherits = FALSE)), envir = .pi_r_session)
      assign(name, list(createdByCall = request$id, lastModifiedByCall = request$id), envir = .pi_r_metadata)
    }
    commit_context(context, character())
  }, error = function(condition) {
    conditions$error <- list(
      code = "TARGET_WORKSPACE_LOAD_FAILED",
      message = substr(conditionMessage(condition), 1L, 2000L),
      recoverable = TRUE,
      recovery = c("Run the failed target with r_targets_run", "Inspect the complete target-run log")
    )
  })
  list(
    target = request$target,
    loaded = if (is.null(conditions$error)) setdiff(ls(.pi_r_session, all.names = TRUE), before) else list(),
    objects = object_inventory(),
    error = conditions$error
  )
}

invalidate_targets <- function() {
  if (length(.pi_r_loaded_targets)) {
    removable <- intersect(.pi_r_loaded_targets, ls(.pi_r_globals, all.names = TRUE))
    if (length(removable)) rm(list = removable, envir = .pi_r_globals)
  }
  .pi_r_loaded_targets <<- character()
}

input <- file("stdin", open = "r")
repeat {
  line <- readLines(input, n = 1L, warn = FALSE)
  if (!length(line)) break
  request <- tryCatch(fromJSON(line, simplifyVector = FALSE), error = identity)
  if (!inherits(request, "error")) .pi_r_sequence <- .pi_r_sequence + 1L
  response <- if (inherits(request, "error")) {
    list(id = NULL, error = list(code = "INVALID_WORKER_REQUEST", message = conditionMessage(request), recoverable = TRUE))
  } else if (identical(request$operation, "evaluate")) {
    c(list(id = request$id), handle_evaluate(request))
  } else if (identical(request$operation, "inspect")) {
    c(list(id = request$id), handle_inspect(request))
  } else if (identical(request$operation, "workspace")) {
    c(list(id = request$id), handle_workspace(request))
  } else if (identical(request$operation, "status")) {
    list(id = request$id, objects = object_inventory(), error = NULL)
  } else if (identical(request$operation, "clear_temporary")) {
    removed <- ls(.pi_r_session, all.names = TRUE)
    clear_environment(.pi_r_session)
    clear_environment(.pi_r_metadata)
    list(id = request$id, removed = as.list(removed), objects = object_inventory(), error = NULL)
  } else if (identical(request$operation, "invalidate_targets")) {
    invalidate_targets()
    list(id = request$id, objects = object_inventory(), error = NULL)
  } else if (identical(request$operation, "reset")) {
    clear_environment(.pi_r_session)
    clear_environment(.pi_r_globals)
    clear_environment(.pi_r_metadata)
    .pi_r_loaded_targets <- character()
    list(id = request$id, objects = object_inventory(), error = NULL)
  } else {
    list(id = request$id, error = list(code = "INVALID_WORKER_REQUEST", message = "Unknown worker operation", recoverable = TRUE))
  }
  cat("PI_R_RESPONSE:", toJSON(response, auto_unbox = TRUE, null = "null", na = "string", digits = NA), "\n", sep = "")
  flush(stdout())
}
