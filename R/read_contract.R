args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 1L)

as_sequence <- function(value) {
  if (is.null(value)) return(list())
  if (is.list(value) && is.null(names(value))) return(value)
  as.list(value)
}

contract <- yaml::read_yaml(args[[1L]], eval.expr = FALSE)
contract$dependencies <- as_sequence(contract$dependencies)
contract$functions <- lapply(as_sequence(contract$functions), function(definition) {
  definition$parameters <- as_sequence(definition$parameters)
  if (!is.null(definition$requirements)) definition$requirements <- as_sequence(definition$requirements)
  if (!is.null(definition$behaviorEvidence)) definition$behaviorEvidence <- as_sequence(definition$behaviorEvidence)
  if (!is.null(definition$behaviorDecisions)) {
    decisions <- definition$behaviorDecisions
    decisions$missingValues$tokens <- as_sequence(decisions$missingValues$tokens)
    decisions$output$columns <- as_sequence(decisions$output$columns)
    decisions$output$key <- as_sequence(decisions$output$key)
    if (!is.null(decisions$joins)) decisions$joins$keys <- as_sequence(decisions$joins$keys)
    if (!is.null(decisions$eventsTime)) decisions$eventsTime$dateColumns <- as_sequence(decisions$eventsTime$dateColumns)
    definition$behaviorDecisions <- decisions
  }
  definition
})
contract$targets <- lapply(as_sequence(contract$targets), function(definition) {
  if (!is.null(definition$pattern)) {
    definition$pattern$over <- as_sequence(definition$pattern$over)
  }
  definition
})

cat(jsonlite::toJSON(
  contract,
  auto_unbox = TRUE,
  null = "null",
  digits = NA,
  pretty = FALSE
))
