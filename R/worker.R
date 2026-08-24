suppressPackageStartupMessages(library(jsonlite))

.pi_r_globals <- new.env(parent = globalenv())
.pi_r_session <- new.env(parent = .pi_r_globals)
.pi_r_loaded_targets <- character()
.pi_r_project_root <- getwd()

bound_text <- function(lines, max_bytes = 8192L, max_lines = 200L) {
  lines <- as.character(lines)
  truncated <- length(lines) > max_lines
  if (length(lines) > max_lines) lines <- lines[seq_len(max_lines)]
  text <- paste(lines, collapse = "\n")
  if (nchar(text, type = "bytes") > max_bytes) {
    text <- substr(text, 1L, max_bytes)
    truncated <- TRUE
  }
  list(text = text, truncated = truncated)
}

object_inventory <- function() {
  session_names <- ls(.pi_r_session, all.names = TRUE)
  global_names <- ls(.pi_r_globals, all.names = TRUE)
  names <- sort(unique(c(session_names, global_names)))
  if (length(names) > 200L) names <- names[seq_len(200L)]
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
    list(name = name, bytes = length(serialize(value, NULL)), class = class(value), origin = origin)
  })
}

safe_value <- function(value) {
  if (is.null(value)) return(NULL)
  if (is.atomic(value) && length(value) <= 100L && is.null(attributes(value)) && length(serialize(value, NULL)) <= 4096L) return(value)
  list(class = class(value), length = length(value), bytes = length(serialize(value, NULL)))
}

clear_environment <- function(environment) {
  names <- ls(environment, all.names = TRUE)
  if (length(names)) rm(list = names, envir = environment)
}

load_context <- function(target_names) {
  setwd(.pi_r_project_root)
  if (identical(Sys.getenv("PI_R_WORKER_ENVIRONMENT"), "project") && file.exists("pi-r.yml")) {
    contract <- fromJSON("pi-r.yml", simplifyVector = TRUE)
    for (package in contract$dependencies) {
      suppressPackageStartupMessages(library(package, character.only = TRUE))
    }
  }
  if (length(.pi_r_loaded_targets)) {
    removable <- intersect(.pi_r_loaded_targets, ls(.pi_r_globals, all.names = TRUE))
    if (length(removable)) rm(list = removable, envir = .pi_r_globals)
  }
  .pi_r_loaded_targets <<- character()

  if (dir.exists("R")) {
    source_files <- sort(list.files("R", pattern = "[.]R$", full.names = TRUE))
    for (source_file in source_files) sys.source(source_file, envir = .pi_r_globals)
  }
  if (file.exists("_targets.R") && requireNamespace("targets", quietly = TRUE)) {
    sys.source("_targets.R", envir = .pi_r_globals)
  }
  if (exists("PI_R_CONSTANTS", envir = .pi_r_globals, inherits = FALSE)) {
    list2env(get("PI_R_CONSTANTS", envir = .pi_r_globals), envir = .pi_r_globals)
  }

  for (name in target_names) {
    if (!grepl("^[A-Za-z][A-Za-z0-9._]*$", name)) stop("Invalid canonical target name: ", name)
    if (exists(name, envir = .pi_r_session, inherits = FALSE)) rm(list = name, envir = .pi_r_session)
    assign(name, targets::tar_read_raw(name), envir = .pi_r_globals)
  }
  .pi_r_loaded_targets <<- target_names
}

handle_evaluate <- function(request) {
  conditions <- new.env(parent = emptyenv())
  conditions$warnings <- character()
  conditions$messages <- character()
  conditions$error <- NULL
  value <- NULL
  preview <- list(text = "", truncated = FALSE)
  tryCatch(
    withCallingHandlers({
      load_context(unlist(request$targets %||% character(), use.names = FALSE))
      expressions <- parse(text = request$code, keep.source = FALSE)
      for (expression in expressions) value <- eval(expression, envir = .pi_r_session)
      preview_value <- if (is.atomic(value)) {
        paste(class(value), paste(value[seq_len(min(length(value), 20L))], collapse = " "), sep = ": ")
      } else {
        paste(class(value), "length", length(value), "bytes", length(serialize(value, NULL)))
      }
      preview <- bound_text(preview_value)
    }, warning = function(condition) {
      conditions$warnings <- c(conditions$warnings, conditionMessage(condition))
      invokeRestart("muffleWarning")
    }, message = function(condition) {
      conditions$messages <- c(conditions$messages, conditionMessage(condition))
      invokeRestart("muffleMessage")
    }),
    error = function(condition) {
      conditions$error <- list(
        code = "R_EVALUATION_ERROR",
        message = substr(conditionMessage(condition), 1L, 2000L),
        recoverable = TRUE,
        recovery = c("Revise the expression or requested target names", "Use r_worker_status to inspect retained objects")
      )
    }
  )
  list(
    value = if (is.null(conditions$error)) safe_value(value) else NULL,
    preview = preview$text,
    previewTruncated = preview$truncated,
    warnings = unname(substr(conditions$warnings[seq_len(min(length(conditions$warnings), 50L))], 1L, 1000L)),
    messages = unname(substr(conditions$messages[seq_len(min(length(conditions$messages), 50L))], 1L, 1000L)),
    error = conditions$error,
    objects = object_inventory()
  )
}

`%||%` <- function(left, right) if (is.null(left)) right else left

input <- file("stdin", open = "r")
repeat {
  line <- readLines(input, n = 1L, warn = FALSE)
  if (!length(line)) break
  request <- tryCatch(fromJSON(line, simplifyVector = FALSE), error = identity)
  response <- if (inherits(request, "error")) {
    list(id = NULL, error = list(code = "INVALID_WORKER_REQUEST", message = conditionMessage(request), recoverable = TRUE))
  } else if (identical(request$operation, "evaluate")) {
    c(list(id = request$id), handle_evaluate(request))
  } else if (identical(request$operation, "status")) {
    list(id = request$id, objects = object_inventory(), error = NULL)
  } else if (identical(request$operation, "reset")) {
    clear_environment(.pi_r_session)
    clear_environment(.pi_r_globals)
    .pi_r_loaded_targets <- character()
    list(id = request$id, objects = object_inventory(), error = NULL)
  } else {
    list(id = request$id, error = list(code = "INVALID_WORKER_REQUEST", message = "Unknown worker operation", recoverable = TRUE))
  }
  cat(toJSON(response, auto_unbox = TRUE, null = "null", na = "string", digits = NA), "\n", sep = "")
  flush(stdout())
}
